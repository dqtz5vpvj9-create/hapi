import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection } from './projection';

function harness() {
    // Model the hub's existing unique localId storage across reconnects.
    const durable = new Map<string, unknown>();
    const sendSessionEvent = vi.fn((event: unknown, id: string) => durable.set(id, event));
    const sendAgentMessage = vi.fn();
    const projection = new SharedCodexProjection({ getMetadata: () => ({}), sendSessionEvent, sendAgentMessage } as unknown as ApiSessionClient, 'native-thread', async () => {});
    return { projection, durable, sendSessionEvent, sendAgentMessage };
}

describe('native interrupted turn projection', () => {
    it('persists a stop event for the interrupted turn, not for the next completed turn', async () => {
        const h = harness();
        await h.projection.notification('turn/completed', { threadId: 'native-thread', turn: { id: 'stopped-turn', status: 'interrupted' } });
        expect([...h.durable.values()]).toEqual([{ type: 'message', message: 'Aborted by user' }]);
        expect(h.sendAgentMessage.mock.calls.every(([body]) => body.type === 'native-turn')).toBe(true);
        await h.projection.notification('turn/completed', { threadId: 'native-thread', turn: { id: 'next-turn', status: 'completed' } });
        expect(h.durable.size).toBe(1);
        await h.projection.notification('turn/completed', { threadId: 'native-thread', turn: { id: 'stopped-turn', status: 'interrupted' } });
        expect(h.sendSessionEvent).toHaveBeenCalledTimes(1);
    });

    it('recovers an itemless interrupted snapshot and reuses its identity after reset/live replay', async () => {
        const h = harness();
        const snapshot = { turns: [{ id: 'stopped-turn', status: 'interrupted', items: [] }, { id: 'next-turn', status: 'completed', items: [] }] };
        await h.projection.history(snapshot);
        expect(h.durable.size).toBe(1);
        const first = h.sendSessionEvent.mock.calls[0];
        h.projection.reset();
        await h.projection.history(snapshot);
        await h.projection.notification('turn/completed', { threadId: 'native-thread', turn: snapshot.turns[0] });
        expect(h.sendSessionEvent).toHaveBeenCalledTimes(2);
        expect(h.sendSessionEvent.mock.calls[1]).toEqual(first);
        expect(h.durable.size).toBe(1);
        expect(h.sendAgentMessage.mock.calls.every(([body]) => body.type === 'native-turn')).toBe(true);
    });
});
