import { describe, expect, it } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';

const proposed = { path: '/src/proposed', kind: { type: 'add' }, diff: 'proposed\n' };
const final = { path: '/src/final', kind: { type: 'update', move_path: null }, diff: '@@ -40 +42 @@\n-old\n+new\n' };
const params = (changes: unknown, status = 'completed') => ({ threadId: 'thread', turnId: 'turn', item: { id: 'patch', type: 'fileChange', changes, status } });

describe('authoritative app-server file changes', () => {
    it('keeps the completed changes instead of the proposed start snapshot', () => {
        const converter = new AppServerEventConverter();
        converter.handleNotification('item/started', params([proposed], 'inProgress'));
        expect(converter.handleNotification('item/completed', params([final]))).toEqual([{
            type: 'patch_apply_end', thread_id: 'thread', turn_id: 'turn', call_id: 'patch', success: true,
            changes: { '/src/final': final }
        }]);
    });

    it('seeds the actual tool for a completed-only fileChange without losing the diff', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('item/completed', params([final]));
        expect(events.map(event => event.type)).toEqual(['patch_apply_begin', 'patch_apply_end']);
        for (const event of events) expect(event).toMatchObject({ call_id: 'patch', changes: { '/src/final': final } });
    });

    it('accepts an authoritative empty snapshot and retains unknown per-path data verbatim', () => {
        const converter = new AppServerEventConverter();
        converter.handleNotification('item/started', params([proposed], 'inProgress'));
        expect(converter.handleNotification('item/completed', params([]))[0].changes).toEqual({});
        const changes = { '/future': { unknown: ['raw'], extra: { keep: true } } };
        expect(converter.handleNotification('item/completed', params(changes, 'failed')).at(-1)).toMatchObject({ changes, success: false });
    });
});
