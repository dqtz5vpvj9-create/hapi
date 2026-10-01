import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { CodexSubagentMessagesResponse } from '@hapi/protocol/apiTypes';

/** Read a bounded tail of a native rollout; never load or resume its engine. */
export function readCodexSubagentMessages(threadId: string, limit = 40, before?: number,
    home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): CodexSubagentMessagesResponse {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const database = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!database) throw new Error('Native Codex index is unavailable');
    const db = new Database(join(home, database), { readonly: true });
    let file: string;
    try {
        const row = db.query('SELECT rollout_path FROM threads WHERE id = ?').get(threadId) as { rollout_path: string } | null;
        if (!row?.rollout_path || !existsSync(row.rollout_path)) throw new Error('Subagent transcript is unavailable');
        file = realpathSync(row.rollout_path);
    } finally { db.close(); }
    if (!['sessions', 'archived_sessions'].some(directory => {
        const rel = relative(realpathSync(home), file);
        return !isAbsolute(rel) && !rel.startsWith('..') && (rel.startsWith(`${directory}/`) || rel.startsWith(`${directory}\\`));
    })) throw new Error('Native transcript is outside the Codex store');
    const end = Math.min(before ?? statSync(file).size, statSync(file).size);
    const start = Math.max(0, end - 2 * 1024 * 1024);
    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(end - start);
    let size: number;
    try { size = readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    const records: Array<{ offset: number; message: CodexSubagentMessagesResponse['messages'][number] }> = [];
    for (let offset = 0; offset < size;) {
        const at = start + offset;
        const newline = buffer.indexOf(10, offset);
        const next = newline < 0 || newline >= size ? size : newline;
        const line = buffer.subarray(offset, next).toString('utf8');
        offset = next + 1;
        if (at === start && start > 0 || !line.trim()) continue;
        let entry: Record<string, any>;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'response_item') continue;
        const item = entry.payload ?? {};
        let role: 'user' | 'assistant' | 'tool'; let text = '';
        if (item.type === 'message' && ['user', 'assistant'].includes(item.role)) {
            role = item.role;
            text = (item.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
        } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
            role = 'tool'; text = `${item.name ?? 'Tool'}\n${typeof (item.arguments ?? item.input) === 'string' ? item.arguments ?? item.input : JSON.stringify(item.arguments ?? item.input ?? {})}`;
        } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
            role = 'tool'; text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        } else continue;
        if (text.trim()) records.push({ offset: at, message: { id: `${threadId}:${at}`, role, text: text.length > 64000 ? `${text.slice(0, 64000)}\n[Output truncated]` : text,
            createdAt: Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : 0 } });
    }
    const selected = records.slice(-limit);
    const boundary = selected[0]?.offset ?? start;
    return { threadId, messages: selected.map(item => item.message), before: boundary > 0 ? boundary : null, hasMore: boundary > 0 };
}
