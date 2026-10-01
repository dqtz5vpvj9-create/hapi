import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexSubagent } from '@hapi/protocol/types';
import type { CodexSessionLineage } from '@hapi/protocol/apiTypes';
import { codexSubagentMetadata } from './codexSubagentMetadata';

/** Batch metadata lookup for existing HAPI rows. Never opens a native thread or imports messages. */
export function lookupCodexSessionLineage(ids: readonly string[], home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): CodexSessionLineage[] {
    if (!ids.length || !existsSync(home)) return [];
    const requested = new Set(ids);
    const found = new Map<string, CodexSessionLineage>();
    const files = new Map<string, string>();
    const unresolved = new Set<string>();
    const children = new Map<string, CodexSubagent[]>();
    const databases = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
    if (databases.length) {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(join(home, databases[0]), { readonly: true });
        try {
            const available = new Set((db.query('PRAGMA table_info(threads)').all() as { name: string }[]).map(column => column.name));
            const columns = ['id', 'cwd', 'source', 'rollout_path', 'thread_source', 'parent_thread_id', 'agent_nickname', 'agent_role', 'agent_path', 'archived', 'updated_at', 'updated_at_ms']
                .filter(column => available.has(column));
            const indexed = db.query(`SELECT ${columns.join(', ')} FROM threads ORDER BY id`).all() as Record<string, unknown>[];
            const byId = new Map(indexed.map(row => [row.id, row]));
            for (const row of indexed) {
                let lineage = codexSubagentMetadata(row);
                if (isSubagent(row) && !lineage.codexParentThreadId && typeof row.rollout_path === 'string') {
                    const header = readHeader(row.rollout_path);
                    if (header?.id === row.id) lineage = codexSubagentMetadata({ ...row, ...header });
                }
                if (!lineage.codexParentThreadId || typeof row.id !== 'string') continue;
                const entry: CodexSubagent = {
                    threadId: row.id, parentThreadId: lineage.codexParentThreadId,
                    nickname: lineage.codexAgentNickname, role: lineage.codexAgentRole,
                    path: typeof row.cwd === 'string' ? row.cwd : undefined,
                    updatedAt: typeof row.updated_at_ms === 'number' ? row.updated_at_ms : typeof row.updated_at === 'number' ? row.updated_at * 1000 : undefined,
                    status: row.archived ? 'archived' : 'unknown'
                };
                const siblings = children.get(entry.parentThreadId) ?? [];
                siblings.push(entry); children.set(entry.parentThreadId, siblings);
            }
            for (const id of requested) {
                const row = byId.get(id);
                if (!row) continue;
                const lineage = codexSubagentMetadata(row);
                if (isSubagent(row)) unresolved.add(id);
                const identity = Object.fromEntries([['codexAgentNickname', row.agent_nickname], ['codexAgentRole', row.agent_role], ['codexAgentPath', row.agent_path]]
                    .filter(([, value]) => typeof value === 'string' && value.trim()));
                found.set(id, { id, cwd: typeof row.cwd === 'string' ? row.cwd : null,
                    codexUpdatedAt: typeof row.updated_at_ms === 'number' ? row.updated_at_ms
                        : typeof row.updated_at === 'number' ? row.updated_at * 1000 : undefined,
                    ...identity, ...lineage });
                // Older indices sometimes preserve only the source kind, so use the header for its parent.
                if (!lineage.codexParentThreadId && typeof row.rollout_path === 'string')
                    files.set(id, row.rollout_path);
            }
        } finally { db.close(); }
    }
    const missing = new Set([...requested].filter(id => !found.has(id)));
    if (missing.size) {
        const visit = (directory: string) => {
            if (!existsSync(directory)) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) visit(path);
                else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    const id = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(entry.name)?.[1];
                    if (id && missing.has(id)) files.set(id, path);
                }
            }
        };
        visit(join(home, 'sessions')); visit(join(home, 'archived_sessions'));
    }
    for (const [id, file] of files) {
        const payload = readHeader(file);
        if (payload?.id === id) {
            if (isSubagent(payload)) unresolved.add(id);
            const lineage = Object.fromEntries(Object.entries(codexSubagentMetadata(payload)).filter(([, value]) => value !== undefined));
            found.set(id, { ...found.get(id), id, cwd: typeof payload.cwd === 'string' ? payload.cwd : found.get(id)?.cwd, ...lineage });
            const parent = typeof lineage.codexParentThreadId === 'string' ? lineage.codexParentThreadId : undefined;
            if (parent && !(children.get(parent) ?? []).some(child => child.threadId === id)) {
                const siblings = children.get(parent) ?? [];
                const known = found.get(id)!;
                siblings.push({ threadId: id, parentThreadId: parent, nickname: known.codexAgentNickname,
                    role: known.codexAgentRole, path: known.cwd ?? undefined, status: file.includes('/archived_sessions/') ? 'archived' : 'unknown' });
                children.set(parent, siblings);
            }
        }
    }
    return [...found.values()].filter(item => !unresolved.has(item.id) || item.codexParentThreadId).map(item => {
        const descendants: CodexSubagent[] = [];
        const visited = new Set([item.id]);
        const pending = [...(children.get(item.id) ?? [])];
        for (let offset = 0; offset < pending.length; offset++) {
            const child = pending[offset];
            if (visited.has(child.threadId)) continue;
            visited.add(child.threadId); descendants.push(child);
            pending.push(...(children.get(child.threadId) ?? []));
        }
        return { ...item, codexSubagents: descendants.sort((a, b) => a.threadId.localeCompare(b.threadId)) };
    });
}

function isSubagent(metadata: Record<string, unknown>): boolean {
    let source = metadata.source;
    if (typeof source === 'string' && source.startsWith('{')) {
        try { source = JSON.parse(source); } catch { /* Plain source kind. */ }
    }
    return metadata.thread_source === 'subagent' || source === 'subagent'
        || Boolean(source && typeof source === 'object' && Object.hasOwn(source, 'subagent'));
}

function readHeader(file: string): Record<string, unknown> | null {
    let fd: number | undefined;
    try {
        fd = openSync(file, 'r');
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(4096);
        for (let offset = 0; offset < 1024 * 1024;) {
            const size = readSync(fd, buffer, 0, buffer.length, offset);
            if (!size) break;
            const end = buffer.subarray(0, size).indexOf(10);
            chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? size : end)));
            offset += size;
            if (end >= 0) break;
        }
        const entry = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string; payload?: Record<string, unknown> };
        return entry.type === 'session_meta' ? entry.payload ?? null : null;
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
}
