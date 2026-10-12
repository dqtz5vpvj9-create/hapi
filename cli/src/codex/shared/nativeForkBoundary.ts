import { closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { NativeForkBoundary } from '@hapi/protocol/apiTypes';
import { openNativeMetadata, type NativeMetadataDatabase } from './nativeHistoryMetadata';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^rollout-.+-(${UUID})(?:_(${UUID}))?\\.jsonl$`, 'i');
const MAX_SEGMENTS = 64;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_TOTAL_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 50_000;
// Only positive physical locators are cached, never a boundary proof. Every
// use still checks the managed path/header/range; archive moves can be retried.
const rolloutPaths = new Map<string, string>();
const rememberPath = (key: string, path: string) => {
    rolloutPaths.delete(key); rolloutPaths.set(key, path);
    if (rolloutPaths.size > 512) rolloutPaths.delete(rolloutPaths.keys().next().value!);
};
const unavailable = (detail: string) => new Error(`Native fork boundary unavailable: ${detail}`);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
type Position = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
type Segment = { id: string; path: string; start: number; end?: Position; size: number; header: string };
type Turn = { rollout_ordinal: number; rollout_byte_offset: number | null; rollout_end_ordinal: number | null; first_user_item_id: string | null };
type Item = { rollout_ordinal: number };

function physicalId(path: string): string | undefined {
    const match = basename(path).match(ROLLOUT);
    return match?.[2] ?? match?.[1];
}

/** Resolve only the selected bound store's plain, persisted lineage. The work
 * budget applies during directory iteration, not after an unbounded glob. */
function lineage(home: string, threadId: string, currentPath: string): Segment[] {
    const store = realpathSync(home);
    const key = (id: string) => `${store}\0${id}`;
    const roots = ['sessions', 'archived_sessions'].flatMap(name => {
        try { return [realpathSync(join(home, name))]; } catch { return []; }
    });
    const managed = (path: string) => {
        const canonical = realpathSync(path);
        if (!roots.some(root => { const rel = relative(root, canonical); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); })) {
            throw unavailable('rollout is outside the bound Codex store');
        }
        return canonical;
    };
    let entries = 0;
    let headers = 0;
    const locate = (id: string): string => {
        const cached = rolloutPaths.get(key(id));
        if (cached) {
            try { realpathSync(cached); rememberPath(key(id), cached); return cached; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                rolloutPaths.delete(key(id));
            }
        }
        const walk = (path: string, depth: number): string | undefined => {
            const directory = opendirSync(path);
            try {
                for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
                    if (++entries > MAX_DIRECTORY_ENTRIES) throw unavailable('lineage directory budget exceeded');
                    const file = join(path, entry.name);
                    if (entry.isFile() && physicalId(file) === id) return file;
                    // Do not follow directory symlinks or arbitrary nested trees.
                    if (entry.isDirectory() && depth < 3) {
                        const found = walk(file, depth + 1);
                        if (found) return found;
                    }
                }
            } finally { directory.closeSync(); }
            return undefined;
        };
        // Nearby branches/replacements usually share a date directory. Stop
        // at the exact physical ID; do not enumerate unrelated history first.
        const nearby = walk(dirname(currentPath), 3);
        if (nearby) return nearby;
        for (const root of roots) {
            const found = walk(root, 0);
            if (found) return found;
        }
        throw unavailable('missing plain lineage rollout');
    };
    const segments: Segment[] = [];
    const seen = new Set<string>();
    let path = currentPath;
    let end: Position | undefined;
    for (;;) {
        if (segments.length === MAX_SEGMENTS) throw unavailable('lineage depth budget exceeded');
        path = managed(path);
        const id = physicalId(path);
        if (!id || (end && id !== end.thread_id) || seen.has(id)) throw unavailable('invalid or cyclic rollout lineage');
        seen.add(id);
        const fd = openSync(path, 'r');
        let size: number;
        let header: string;
        try {
            size = fstatSync(fd).size;
            const chunks: Buffer[] = [];
            let length = 0;
            for (;;) {
                const buffer = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES + 1 - length));
                const bytes = readSync(fd, buffer, 0, buffer.length, null);
                headers += bytes;
                if (headers > MAX_TOTAL_HEADER_BYTES) throw unavailable('lineage header budget exceeded');
                const newline = buffer.subarray(0, bytes).indexOf(10);
                chunks.push(buffer.subarray(0, newline < 0 ? bytes : newline));
                length += newline < 0 ? bytes : newline + 1;
                if (length > MAX_HEADER_BYTES || !bytes) throw unavailable('session header is incomplete or too large');
                if (newline >= 0) break;
            }
            header = Buffer.concat(chunks).toString('utf8');
        } finally { closeSync(fd); }
        const entry = JSON.parse(header) as { type?: string; ordinal?: unknown; payload?: { id?: string; history_mode?: string; history_base?: Position; forked_from_ordinal_exclusive?: unknown } };
        const meta = entry.payload;
        if (entry.type !== 'session_meta' || meta?.history_mode !== 'paginated' || !integer(entry.ordinal)
            || (!segments.length && meta.id !== threadId)) throw unavailable('unsupported session metadata');
        const base = meta.history_base;
        if (base && (!new RegExp(`^${UUID}$`, 'i').test(base.thread_id) || !integer(base.end_ordinal_exclusive)
            || base.end_ordinal_exclusive < 1 || !integer(base.end_byte_offset))) throw unavailable('invalid history_base');
        // A legacy sparse header without history_base cannot prove the physical
        // ancestry. Never infer it from the public forked_from_id.
        if (!base && meta.forked_from_ordinal_exclusive != null) throw unavailable('legacy sparse lineage has no history_base');
        const start = base ? base.end_ordinal_exclusive + 1 : 1;
        if (!Number.isSafeInteger(start) || entry.ordinal !== start - 1 || end && (end.end_byte_offset > size || end.end_ordinal_exclusive < start)) {
            throw unavailable('invalid lineage range');
        }
        rememberPath(key(id), path);
        segments.push({ id, path, start, end, size, header });
        if (!base) break;
        end = base;
        path = locate(base.thread_id);
    }
    return segments.reverse();
}

function requirePrimaryKey(database: NativeMetadataDatabase, table: string, columns: string[]): void {
    const fields = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const primary = fields.filter(field => field.pk).sort((a, b) => a.pk - b.pk).map(field => field.name);
    if (primary.join(',') !== columns.join(',')) throw unavailable(`unsupported ${table} index`);
}

/** Resolve the earliest source turn, as native BeforeTurn does. Read only
 * indexed scalar metadata: never item_json, full turns, or a projection replay. */
export function resolveNativeForkBoundary(home: string, thread: Record<string, unknown>, boundary: NativeForkBoundary): string {
    if (thread.id !== boundary.threadId) throw unavailable('source thread mismatch');
    if (thread.historyMode !== 'paginated' || typeof thread.path !== 'string') throw unavailable('persisted paginated history is required');
    const segments = lineage(home, boundary.threadId, thread.path);
    const database = openNativeMetadata(home);
    try {
        database.query('PRAGMA busy_timeout = 100').get();
        requirePrimaryKey(database, 'thread_turns', ['thread_id', 'turn_id']);
        requirePrimaryKey(database, 'thread_items', ['thread_id', 'turn_id', 'item_id']);
        requirePrimaryKey(database, 'thread_history_projection_state', ['thread_id']);
        database.query('BEGIN').get();
        for (const segment of segments) {
            const turn = database.query(`SELECT rollout_ordinal, rollout_byte_offset, rollout_end_ordinal, first_user_item_id
                FROM thread_turns WHERE thread_id = ? AND turn_id = ? AND rollout_ordinal >= ?
                AND (? IS NULL OR rollout_ordinal < ?)`)
                .get(segment.id, boundary.turnId, segment.start, segment.end?.end_ordinal_exclusive ?? null, segment.end?.end_ordinal_exclusive ?? null) as Turn | undefined;
            const checkpoint = database.query('SELECT next_rollout_ordinal, next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ?')
                .get(segment.id) as { next_rollout_ordinal: number; next_rollout_byte_offset: number } | undefined;
            if (!checkpoint || !integer(checkpoint.next_rollout_ordinal) || !integer(checkpoint.next_rollout_byte_offset)
                || checkpoint.next_rollout_byte_offset > statSync(segment.path).size) throw unavailable('projection checkpoint is unavailable');
            if (!turn) {
                // Otherwise a later completion-only row could masquerade as
                // the earliest source while the ancestor index is behind.
                if (segment.end && (checkpoint.next_rollout_ordinal < segment.end.end_ordinal_exclusive
                    || checkpoint.next_rollout_byte_offset < segment.end.end_byte_offset)) throw unavailable('ancestor metadata is not synchronized');
                continue;
            }
            if (!integer(turn.rollout_ordinal) || !integer(turn.rollout_byte_offset)
                || turn.rollout_end_ordinal === turn.rollout_ordinal) throw unavailable('turn has no persisted start boundary');
            if (!turn.first_user_item_id) throw unavailable('first user metadata is not synchronized');
            if (turn.first_user_item_id !== boundary.itemId) throw new Error('Cannot cut inside a steered native turn. Select its first message.');
            const item = database.query('SELECT rollout_ordinal FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?')
                .get(segment.id, boundary.turnId, boundary.itemId) as Item | undefined;
            // The native first_user_item_id summary is authoritative. Reading
            // item_type (added after item_json) may traverse huge SQLite overflow
            // payloads even though item_json is not selected.
            if (!item || !integer(item.rollout_ordinal)
                || item.rollout_ordinal < segment.start || segment.end && item.rollout_ordinal >= segment.end.end_ordinal_exclusive
                || !checkpoint || !integer(checkpoint.next_rollout_ordinal) || !integer(checkpoint.next_rollout_byte_offset)
                || checkpoint.next_rollout_ordinal <= Math.max(item.rollout_ordinal, turn.rollout_ordinal)
                || checkpoint.next_rollout_byte_offset <= turn.rollout_byte_offset
                || segment.end && turn.rollout_byte_offset >= segment.end.end_byte_offset) throw unavailable('boundary metadata is missing, stale, or outside visible history');
            // Synchronous lookup cannot interleave HAPI mutations. Reject a
            // concurrent physical truncation before native validates the cut.
            if (segments.some(value => statSync(value.path).size < value.size)) throw unavailable('history changed during boundary validation');
            return boundary.turnId;
        }
        throw unavailable('turn is not in the source history');
    } catch (error) {
        if (error instanceof Error && (error.message.startsWith('Native fork boundary unavailable:') || error.message.startsWith('Cannot cut inside'))) throw error;
        throw unavailable('required native metadata schema is missing or unreadable');
    } finally { database.close(); }
}
