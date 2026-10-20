import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const cache = new Map<string, { size: number; mtime: number; at: number | undefined }>();
const events = new Set(['user_message', 'agent_message', 'task_started', 'task_complete',
    'turn_started', 'turn_complete', 'turn_aborted', 'exec_command_begin', 'exec_command_end',
    'function_call', 'function_call_output']);

/** Settings, resume and usage bookkeeping must not move a conversation in Recent. */
function activity(line: string): number | undefined {
    try {
        const row = JSON.parse(line);
        const payload = row.payload;
        const meaningful = row.type === 'session_meta'
            || (row.type === 'event_msg' && events.has(payload?.type))
            || (row.type === 'response_item' && (
                (payload?.type === 'message' && ['user', 'assistant'].includes(payload.role))
                || ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(payload?.type)));
        if (!meaningful) return undefined;
        const at = Date.parse(row.timestamp);
        return Number.isFinite(at) ? at : undefined;
    } catch { return undefined; }
}

/** Read backwards, usually one block, and reuse results until the rollout changes. */
export function readCodexRolloutActivity(path: string): number | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const stat = fstatSync(fd);
        const previous = cache.get(path);
        if (previous?.size === stat.size && previous.mtime === stat.mtimeMs) return previous.at;
        let position = stat.size;
        let remainder = Buffer.alloc(0);
        let at: number | undefined;
        while (position > 0 && at === undefined) {
            const length = Math.min(position, 64 * 1024);
            position -= length;
            const block = Buffer.allocUnsafe(length);
            const count = readSync(fd, block, 0, length, position);
            const combined = Buffer.concat([block.subarray(0, count), remainder]);
            let end = combined.length;
            for (let i = combined.length - 1; i >= 0; i--) {
                if (combined[i] !== 10) continue;
                at = activity(combined.toString('utf8', i + 1, end));
                end = i;
                if (at !== undefined) break;
            }
            remainder = combined.subarray(0, end);
            if (position === 0 && at === undefined) at = activity(remainder.toString('utf8'));
        }
        if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
        cache.set(path, { size: stat.size, mtime: stat.mtimeMs, at });
        return at;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
}
