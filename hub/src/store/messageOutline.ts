import type { Database } from 'bun:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { extractConversationOutlineLabel } from '@hapi/protocol/conversationOutline'
import { prepareCached } from './statementCache'

const VERSION = 1
const MAX_ROW_BYTES = 2 * 1024 * 1024
export type OutlinePosition = { at: number; seq: number }
export type OutlineEntry = { messageId: string; label: string; at: number; seq: number; createdAt: number }

/** Sparse labels only; the canonical messages table remains the content owner. */
export function createMessageOutlineSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS message_outline (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            position_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            label TEXT NOT NULL,
            eligible INTEGER NOT NULL CHECK(eligible IN (0,1))
        );
        CREATE INDEX IF NOT EXISTS idx_message_outline_position
            ON message_outline(session_id, eligible, position_at, seq);
        CREATE TABLE IF NOT EXISTS message_outline_unreadable (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_message_outline_unreadable_session ON message_outline_unreadable(session_id);
        CREATE TABLE IF NOT EXISTS message_outline_scan (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            version INTEGER NOT NULL, epoch INTEGER NOT NULL, last_seq INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS message_outline_content_changed
        AFTER UPDATE OF content ON messages WHEN OLD.content IS NOT NEW.content BEGIN
            DELETE FROM message_outline WHERE message_id = NEW.id;
            DELETE FROM message_outline_unreadable WHERE message_id = NEW.id;
            DELETE FROM message_outline_scan WHERE session_id = NEW.session_id;
        END;
        CREATE TRIGGER IF NOT EXISTS message_outline_position_changed
        AFTER UPDATE OF session_id, seq, invoked_at, created_at ON messages BEGIN
            UPDATE message_outline SET session_id=NEW.session_id, seq=NEW.seq,
                position_at=COALESCE(NEW.invoked_at, NEW.created_at),
                eligible=(NEW.invoked_at IS NOT NULL) WHERE message_id=NEW.id;
            UPDATE message_outline_unreadable SET session_id=NEW.session_id WHERE message_id=NEW.id;
            DELETE FROM message_outline_scan WHERE OLD.session_id != NEW.session_id
                AND session_id IN (OLD.session_id, NEW.session_id);
        END;
    `)
}

/** Invoke inside the canonical message write transaction, after its row exists. */
export function indexMessageOutline(db: Database, messageId: string, content: unknown): void {
    const label = extractConversationOutlineLabel(content)
    prepareCached(db, 'DELETE FROM message_outline_unreadable WHERE message_id=?').run(messageId)
    if (label === null) {
        prepareCached(db, 'DELETE FROM message_outline WHERE message_id=?').run(messageId)
        return
    }
    prepareCached(db, `INSERT INTO message_outline(message_id,session_id,position_at,seq,label,eligible)
        SELECT id,session_id,COALESCE(invoked_at,created_at),seq,?,(invoked_at IS NOT NULL) FROM messages WHERE id=?
        ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id,
            position_at=excluded.position_at,seq=excluded.seq,label=excluded.label,eligible=excluded.eligible`).run(label, messageId)
}

function bounds(db: Database, sessionId: string) {
    const epoch = (prepareCached(db, 'SELECT epoch FROM message_epochs WHERE session_id=?').get(sessionId) as { epoch: number } | null)?.epoch ?? 0
    const head = (prepareCached(db, 'SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE session_id=?').get(sessionId) as { seq: number }).seq
    return { epoch, head }
}

export function getMessageOutlineCoverage(db: Database, sessionId: string) {
    const { epoch, head } = bounds(db, sessionId)
    const scan = prepareCached(db, 'SELECT version,epoch,last_seq FROM message_outline_scan WHERE session_id=?')
        .get(sessionId) as { version: number; epoch: number; last_seq: number } | null
    const scannedThrough = scan?.version === VERSION && scan.epoch === epoch ? scan.last_seq : 0
    const unreadable = Boolean((prepareCached(db, 'SELECT EXISTS(SELECT 1 FROM message_outline_unreadable WHERE session_id=?) AS present')
        .get(sessionId) as { present: number }).present)
    return { epoch, scannedThrough, headSeq: head, complete: scannedThrough >= head && !unreadable, unreadable }
}

/** Background work only: at most 128 records, 8ms or 2MiB per batch, except one
 * bounded decode may cross the cumulative budget. Progress commits with labels. */
export function backfillMessageOutline(db: Database, sessionId: string) {
    return db.transaction(() => {
        const started = performance.now()
        const coverage = getMessageOutlineCoverage(db, sessionId)
        const rows = prepareCached(db, `SELECT id,seq,length(CAST(content AS BLOB)) AS bytes FROM messages
            WHERE session_id=? AND seq>? ORDER BY seq LIMIT 128`)
            .all(sessionId, coverage.scannedThrough) as Array<{ id: string; seq: number; bytes: number }>
        let lastSeq = coverage.scannedThrough, enumerated = 0, decodedBytes = 0, chargedBytes = 0
        for (const row of rows) {
            if (enumerated && (performance.now() - started >= 8 || chargedBytes >= MAX_ROW_BYTES)) break
            let parsed: unknown, valid = false
            const stored = row.bytes <= MAX_ROW_BYTES
                ? prepareCached(db, 'SELECT content FROM messages WHERE id=?').get(row.id) as { content: string | Uint8Array }
                : null
            try {
                const json = stored === null ? '' : typeof stored.content === 'string' ? stored.content
                    : zstdDecompressSync(stored.content, { maxOutputLength: MAX_ROW_BYTES }).toString('utf8')
                const bytes = Buffer.byteLength(json)
                if (bytes <= MAX_ROW_BYTES) { parsed = JSON.parse(json); decodedBytes += bytes; chargedBytes += bytes; valid = true }
            } catch { /* Persist unreadability separately from an empty directory. */ }
            if (valid) indexMessageOutline(db, row.id, parsed)
            else {
                chargedBytes += MAX_ROW_BYTES
                prepareCached(db, 'DELETE FROM message_outline WHERE message_id=?').run(row.id)
                prepareCached(db, 'INSERT OR REPLACE INTO message_outline_unreadable(message_id,session_id) VALUES (?,?)').run(row.id, sessionId)
            }
            lastSeq = row.seq
            enumerated++
        }
        prepareCached(db, `INSERT INTO message_outline_scan(session_id,version,epoch,last_seq) VALUES (?,?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,epoch=excluded.epoch,last_seq=excluded.last_seq`)
            .run(sessionId, VERSION, coverage.epoch, lastSeq)
        return { ...getMessageOutlineCoverage(db, sessionId), enumerated, decodedBytes, chargedBytes }
    })()
}

/** Seeks sparse metadata; never decompresses history or advances backfill. */
export function readMessageOutline(db: Database, sessionId: string, before: OutlinePosition | null = null, limit = 40) {
    return db.transaction(() => {
        const pageSize = Math.max(1, Math.min(100, Math.floor(limit)))
        const entries = prepareCached(db, `SELECT o.message_id AS messageId,o.label,o.position_at AS at,o.seq,m.created_at AS createdAt
            FROM message_outline o JOIN messages m ON m.id=o.message_id
            WHERE o.session_id=? AND o.eligible=1
            ${before ? 'AND (o.position_at,o.seq)<(?,?)' : ''}
            ORDER BY o.position_at DESC,o.seq DESC LIMIT ?`)
            .all(sessionId, ...(before ? [before.at, before.seq] : []), pageSize + 1) as OutlineEntry[]
        const hasMore = entries.length > pageSize
        const page = entries.slice(0, pageSize)
        const last = page.at(-1)
        return { entries: page, hasMore, before: hasMore && last ? { at: last.at, seq: last.seq } : null,
            coverage: getMessageOutlineCoverage(db, sessionId) }
    })()
}
