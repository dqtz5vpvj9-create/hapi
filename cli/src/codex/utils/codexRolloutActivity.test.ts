import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexRolloutActivity } from './codexRolloutActivity';
const directories: string[] = [];
const row = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + '\n';
function fixture(text: string) {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-activity-')); directories.push(dir);
    const path = join(dir, 'rollout.jsonl'); writeFileSync(path, text); return path;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true }); });
describe('conversation activity from native rollout', () => {
    const first = '2026-10-09T03:24:55.218Z', later = '2026-10-15T02:15:45.749Z';
    it('ignores settings applied on reconnect and usage records', () => {
        const path = fixture(row(first, 'event_msg', { type: 'task_complete' })
            + row(later, 'event_msg', { type: 'thread_settings_applied' })
            + row(later, 'event_msg', { type: 'token_count' }));
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(first));
    });
    it('finds activity before multiple blocks of bookkeeping including unicode', () => {
        const path = fixture(row(first, 'response_item', { type: 'message', role: 'assistant', text: '完成' })
            + row(later, 'event_msg', { type: 'thread_settings_applied', data: '配置'.repeat(100000) }));
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(first));
    });
    it('refreshes cached activity on actual appended conversation and truncation', () => {
        const path = fixture(row(first, 'event_msg', { type: 'user_message' }));
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(first));
        appendFileSync(path, row(later, 'event_msg', { type: 'exec_command_end' }));
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(later));
        writeFileSync(path, row(first, 'event_msg', { type: 'turn_aborted' }));
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(first));
    });
    it('uses creation for an empty conversation and ignores incomplete trailing records', () => {
        const path = fixture(row(first, 'session_meta', { id: 'empty' }) + '{"timestamp":');
        expect(readCodexRolloutActivity(path)).toBe(Date.parse(first));
    });
    it('does not substitute file or current time when activity is unavailable', () => {
        expect(readCodexRolloutActivity(fixture(row(later, 'event_msg', { type: 'thread_settings_applied' })))).toBeUndefined();
    });
});
