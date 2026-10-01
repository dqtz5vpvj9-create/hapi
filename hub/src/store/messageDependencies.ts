import type { Database } from 'bun:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { extractMessageDependencyFacts, MESSAGE_DEPENDENCY_VERSION, type MessageDependencyKind } from '@hapi/protocol/messageDependencies'
import { prepareCached } from './statementCache'

export function createMessageDependencySchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS message_dependency_state (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            extractor_version INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('indexed', 'unsupported', 'decode_error')),
            is_sidechain INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_message_dependency_state_session
            ON message_dependency_state(session_id, extractor_version, status);
        CREATE TABLE IF NOT EXISTS message_dependency_keys (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            extractor_version INTEGER NOT NULL,
            kind TEXT NOT NULL,
            key TEXT COLLATE BINARY NOT NULL,
            ordinal INTEGER NOT NULL,
            PRIMARY KEY(message_id, kind, key, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_message_dependency_keys_lookup
            ON message_dependency_keys(session_id, extractor_version, kind, key, message_id, ordinal);
        CREATE TABLE IF NOT EXISTS message_dependency_scan (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            extractor_version INTEGER NOT NULL,
            epoch INTEGER NOT NULL,
            last_seq INTEGER NOT NULL,
            head_seq INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS message_dependency_content_changed
        AFTER UPDATE OF content ON messages WHEN OLD.content IS NOT NEW.content BEGIN
            DELETE FROM message_dependency_keys WHERE message_id = NEW.id;
            DELETE FROM message_dependency_state WHERE message_id = NEW.id;
            DELETE FROM message_dependency_scan WHERE session_id = NEW.session_id;
        END;
        CREATE TRIGGER IF NOT EXISTS message_dependency_session_changed
        AFTER UPDATE OF session_id ON messages WHEN OLD.session_id != NEW.session_id BEGIN
            UPDATE message_dependency_keys SET session_id = NEW.session_id WHERE message_id = NEW.id;
            UPDATE message_dependency_state SET session_id = NEW.session_id WHERE message_id = NEW.id;
            DELETE FROM message_dependency_scan WHERE session_id IN (OLD.session_id, NEW.session_id);
        END;
    `)
}

/** Caller owns the message-write transaction; facts describe canonical content. */
export function indexMessageDependencies(db: Database, messageId: string, sessionId: string, content: unknown): void {
    const parsed = extractMessageDependencyFacts(messageId, content)
    prepareCached(db, 'DELETE FROM message_dependency_keys WHERE message_id = ?').run(messageId)
    const insert = prepareCached(db, `INSERT OR IGNORE INTO message_dependency_keys
        (message_id, session_id, extractor_version, kind, key, ordinal) VALUES (?, ?, ?, ?, ?, ?)`)
    for (const fact of parsed.facts) insert.run(messageId, sessionId, MESSAGE_DEPENDENCY_VERSION, fact.kind, fact.key, fact.ordinal)
    prepareCached(db, `INSERT INTO message_dependency_state
        (message_id, session_id, extractor_version, status, is_sidechain) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id,
            extractor_version=excluded.extractor_version, status=excluded.status, is_sidechain=excluded.is_sidechain`)
        .run(messageId, sessionId, MESSAGE_DEPENDENCY_VERSION, parsed.status, Number(parsed.isSidechain))
}

type Scan = { extractor_version: number; epoch: number; last_seq: number; head_seq: number }
type Candidate = { id: string; seq: number; extractor_version: number | null }
const MAX_ROW_BYTES = 2 * 1024 * 1024

/** Incremental legacy backfill, never a whole-history decode in a read request.
 * Limits include metadata enumeration. One bounded decode may cross the time
 * or cumulative byte threshold; total decoded bytes stay below 2*MAX_ROW_BYTES.
 * Failed parse/decompression attempts conservatively charge the row cap;
 * decodedBytes records successful JSON bytes, not allocation or peak heap.
 * Progress and facts commit together so edits cannot race an old parsed row. */
export function backfillMessageDependencies(db: Database, sessionId: string) {
    return db.transaction(() => {
        const started = performance.now()
        const epoch = (prepareCached(db, 'SELECT epoch FROM message_epochs WHERE session_id = ?').get(sessionId) as { epoch: number } | null)?.epoch ?? 0
        const head = (prepareCached(db, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?').get(sessionId) as { seq: number }).seq
        const previous = prepareCached(db, 'SELECT * FROM message_dependency_scan WHERE session_id = ?').get(sessionId) as Scan | null
        let lastSeq = previous?.extractor_version === MESSAGE_DEPENDENCY_VERSION && previous.epoch === epoch ? previous.last_seq : 0
        const candidates = prepareCached(db, `SELECT m.id, m.seq, s.extractor_version FROM messages m
            LEFT JOIN message_dependency_state s ON s.message_id=m.id
            WHERE m.session_id=? AND m.seq>? AND m.seq<=? ORDER BY m.seq ASC LIMIT 128`)
            .all(sessionId, lastSeq, head) as Candidate[]
        let enumerated = 0, decodedBytes = 0, budgetedBytes = 0, decodedRows = 0
        for (const candidate of candidates) {
            if (enumerated > 0 && (performance.now() - started >= 8 || budgetedBytes >= MAX_ROW_BYTES)) break
            if (candidate.extractor_version !== MESSAGE_DEPENDENCY_VERSION) {
                const row = prepareCached(db, 'SELECT content FROM messages WHERE id = ? AND session_id = ?')
                    .get(candidate.id, sessionId) as { content: string | Uint8Array }
                let parsed: { content: unknown; size: number } | null = null
                let unparsedStatus: 'unsupported' | 'decode_error' = 'unsupported'
                try {
                    const json = typeof row.content === 'string' ? row.content : zstdDecompressSync(row.content, { maxOutputLength: MAX_ROW_BYTES }).toString('utf8')
                    const size = Buffer.byteLength(json)
                    if (size <= MAX_ROW_BYTES) parsed = { content: JSON.parse(json) as unknown, size }
                } catch (error) {
                    const quotaExceeded = error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE'
                    unparsedStatus = quotaExceeded ? 'unsupported' : 'decode_error'
                }
                // Index/database failures propagate and roll back the batch;
                // only parse/decompression failures become persistent markers.
                if (parsed) {
                    indexMessageDependencies(db, candidate.id, sessionId, parsed.content)
                    decodedBytes += parsed.size
                    budgetedBytes += parsed.size
                } else {
                    recordUnparsed(db, candidate.id, sessionId, unparsedStatus)
                    budgetedBytes += MAX_ROW_BYTES
                }
                decodedRows++
            }
            lastSeq = candidate.seq
            enumerated++
        }
        prepareCached(db, `INSERT INTO message_dependency_scan
            (session_id, extractor_version, epoch, last_seq, head_seq) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET extractor_version=excluded.extractor_version,
                epoch=excluded.epoch, last_seq=excluded.last_seq, head_seq=excluded.head_seq`)
            .run(sessionId, MESSAGE_DEPENDENCY_VERSION, epoch, lastSeq, head)
        return { epoch, lastSeq, headSeq: head, complete: lastSeq >= head, enumerated, decodedRows, decodedBytes, budgetedBytes }
    })()
}

function recordUnparsed(db: Database, messageId: string, sessionId: string, status: 'unsupported' | 'decode_error') {
    prepareCached(db, 'DELETE FROM message_dependency_keys WHERE message_id = ?').run(messageId)
    prepareCached(db, `INSERT OR REPLACE INTO message_dependency_state
        (message_id, session_id, extractor_version, status, is_sidechain) VALUES (?, ?, ?, ?, 0)`)
        .run(messageId, sessionId, MESSAGE_DEPENDENCY_VERSION, status)
}

/** Scoped candidates only. A hit is not proof of dependency closure or coverage.
 * Use index order to stop at the row budget without sorting all stream/Task
 * members. The closure reader sorts its bounded raw input by actual position;
 * these candidates do not select a parent for an ambiguous legacy prompt. */
export type MessageDependencyCandidateCursor = { messageId: string; ordinal: number }
export type MessageDependencyCandidate = { id: string; seq: number; at: number; ordinal: number; isSidechain: number }

export function findMessageDependencyCandidates(db: Database, sessionId: string, kind: MessageDependencyKind, key: string, limit = 201, after: MessageDependencyCandidateCursor | null = null) {
    return prepareCached(db, `SELECT m.id, m.seq, COALESCE(m.invoked_at, m.created_at) AS at, k.ordinal,
        s.is_sidechain AS isSidechain FROM message_dependency_keys k
        JOIN messages m ON m.id=k.message_id
        JOIN message_dependency_state s ON s.message_id=m.id AND s.extractor_version=?
        WHERE k.extractor_version=? AND k.session_id=? AND m.session_id=? AND k.kind=? AND k.key=?
        ${after ? 'AND (k.message_id, k.ordinal) > (?, ?)' : ''}
        ORDER BY k.message_id, k.ordinal LIMIT ?`)
        .all(MESSAGE_DEPENDENCY_VERSION, MESSAGE_DEPENDENCY_VERSION, sessionId, sessionId, kind, key,
            ...(after ? [after.messageId, after.ordinal] : []), Math.max(1, Math.min(201, Math.floor(limit)))) as MessageDependencyCandidate[]
}


/** Pages one indexed relationship without scanning or sorting its entire group.
 * The cursor includes the block ordinal: a stored row can contain several
 * matching tool calls. Exhausting this index range does not prove that the
 * background index is ready or that the dependency graph is closed. */
export function findMessageDependencyCandidatePage(
    db: Database, sessionId: string, kind: MessageDependencyKind, key: string,
    after: MessageDependencyCandidateCursor | null = null,
): { candidates: MessageDependencyCandidate[]; nextCursor: MessageDependencyCandidateCursor | null } {
    const matches = findMessageDependencyCandidates(db, sessionId, kind, key, 201, after)
    const candidates = matches.slice(0, 200)
    const last = candidates[candidates.length - 1]
    return { candidates, nextCursor: matches.length > 200 ? { messageId: last.id, ordinal: last.ordinal } : null }
}
