import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { CodexSubagentMessagesResponse } from '@hapi/protocol/apiTypes';

const PAGE_BYTES = 2 * 1024 * 1024;
const FIELD_CHARS = 64_000;
type Message = CodexSubagentMessagesResponse['messages'][number];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
function text(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? ''); }
function bounded(value: unknown): { value: unknown; truncated: boolean } {
    const rendered = text(value);
    return rendered.length <= FIELD_CHARS ? { value, truncated: false }
        : { value: `${rendered.slice(0, FIELD_CHARS)}\n[Output truncated]`, truncated: true };
}
function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string' || value.length > FIELD_CHARS) return value;
    try { return JSON.parse(value); } catch { return value; }
}
function contentText(parts: unknown): string {
    if (!Array.isArray(parts)) return typeof parts === 'string' ? parts : '';
    return parts.flatMap(value => {
        const part = object(value);
        if (typeof part.text === 'string') return [part.text];
        if (part.type === 'input_image' || part.type === 'image') return ['[Image attachment]'];
        return [];
    }).join('\n');
}

/** Preserve native tool identity and JSON. Encrypted reasoning is never exposed. */
function parseRecord(line: string, id: string): Message | undefined {
    let entry: Record<string, unknown>;
    try { entry = object(JSON.parse(line)); } catch { return; }
    if (entry.type !== 'response_item') return;
    const item = object(entry.payload);
    const at = Date.parse(string(entry.timestamp) ?? '');
    const base = { id, createdAt: Number.isFinite(at) ? at : 0 };
    let result: Message;
    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
        result = { ...base, role: item.role, kind: 'message', text: contentText(item.content) };
    } else if (item.type === 'reasoning') {
        const summary = contentText(item.summary);
        result = { ...base, role: 'assistant', kind: 'reasoning', text: summary || contentText(item.content) };
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const input = bounded(parseArguments(item.arguments ?? item.input ?? {}));
        const name = string(item.name) ?? 'Tool';
        result = { ...base, role: 'tool', kind: 'tool-call', toolName: name,
            callId: string(item.call_id) ?? string(item.id), input: input.value, truncated: input.truncated,
            text: `${name}\n${text(input.value)}` };
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const output = bounded(item.output ?? '');
        const payload = object(item.output);
        result = { ...base, role: 'tool', kind: 'tool-result', callId: string(item.call_id), output: output.value,
            isError: item.is_error === true || payload.is_error === true || payload.isError === true || payload.success === false,
            truncated: output.truncated, text: text(output.value) };
    } else return;
    if (!result.text.trim() && result.kind !== 'tool-result') return;
    if (result.text.length > FIELD_CHARS) { result.text = `${result.text.slice(0, FIELD_CHARS)}\n[Output truncated]`; result.truncated = true; }
    return result;
}

function readRange(fd: number, start: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let size = 0;
    while (size < length) {
        const read = readSync(fd, buffer, size, length - size, start + size);
        if (!read) break;
        size += read;
    }
    return buffer.subarray(0, size);
}

/** Read bounded native rollout pages without loading, resuming or mutating its engine. */
export function readCodexSubagentMessages(threadId: string, limit = 40, before?: number,
    home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
    updates: { after?: number; epoch?: string } = {}): CodexSubagentMessagesResponse {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || [before, updates.after].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        || (before !== undefined && updates.after !== undefined)) throw new Error('Invalid subagent page cursor');
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
    const fd = openSync(file, 'r');
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('Native transcript is not a regular file');
        const prefix = readRange(fd, 0, Math.min(4096, stat.size));
        const newline = prefix.indexOf(10);
        const epoch = createHash('sha256').update(`${file}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:`)
            .update(newline >= 0 ? prefix.subarray(0, newline) : prefix).digest('hex');
        const reset = (updates.epoch !== undefined && updates.epoch !== epoch)
            || (updates.after !== undefined && updates.after > stat.size);
        const forward = !reset && updates.after !== undefined;
        const end = forward ? Math.min(stat.size, updates.after! + PAGE_BYTES) : Math.min(!reset ? before ?? stat.size : stat.size, stat.size);
        const start = forward ? updates.after! : Math.max(0, end - PAGE_BYTES);
        const buffer = readRange(fd, start, end - start);
        const beginsAtBoundary = start === 0 || readRange(fd, start - 1, 1)[0] === 10;
        const records: Array<{ offset: number; message: Message }> = [];
        let cursor = start;
        let truncated = false;
        let moreRecords = false;
        for (let offset = 0; offset < buffer.length;) {
            const at = start + offset;
            const next = buffer.indexOf(10, offset);
            if (next < 0) {
                // Retry incomplete appends from their original byte boundary.
                // Oversize records advance in bounded chunks with a visible
                // truncation marker instead of allocating an unbounded line.
                if (buffer.length === PAGE_BYTES && at === start) { cursor = start + buffer.length; truncated = true; }
                break;
            }
            const line = buffer.subarray(offset, next).toString('utf8');
            offset = next + 1;
            if (forward && records.length >= limit) { moreRecords = true; break; }
            cursor = start + offset;
            if (at === start && !beginsAtBoundary) { truncated = true; continue; }
            const message = parseRecord(line, `${threadId}:${at}`);
            if (message) records.push({ offset: at, message });
        }
        const selected = forward ? records : records.slice(-limit);
        const boundary = selected[0]?.offset ?? start;
        return { threadId, messages: selected.map(item => item.message),
            before: boundary > 0 ? boundary : null, hasMore: boundary > 0,
            after: cursor, epoch, hasLater: forward && (moreRecords || end < stat.size), reset,
            truncated: truncated || selected.some(item => item.message.truncated) };
    } finally { closeSync(fd); }
}
