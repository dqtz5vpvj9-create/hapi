import { describe, expect, it } from 'vitest';
import { NativeRuntimeStateTracker } from './execution';

const compact = (id = 'compact', turnId = 'turn') => ({ turnId, item: { id, type: 'contextCompaction' } });
const tracker = () => {
    const state = new NativeRuntimeStateTracker('machine', 'generation');
    state.started({ id: 'turn' });
    return state;
};

describe('native compaction lifecycle', () => {
    it('tracks stable item identity, ignoring other items, old turns and duplicate starts after completion', () => {
        const state = tracker();
        expect(state.observeCompaction('item/started', compact())).toBe(true);
        state.observeCompaction('item/completed', compact('other'));
        expect(state.report(true).compacting).toBe(true);
        state.observeCompaction('item/completed', compact('compact', 'previous'));
        expect(state.report(true).compacting).toBe(true);
        state.observeCompaction('item/completed', compact());
        expect(state.report(true).compacting).not.toBe(true);
        expect(state.observeCompaction('item/started', compact())).toBe(false);
        expect(state.observeCompaction('item/started', compact('next'))).toBe(true);
    });
    it.each(['completed', 'failed', 'interrupted'])('clears on %s and ignores late compaction events', status => {
        const state = tracker();
        state.observeCompaction('item/started', compact());
        state.completed({ id: 'turn', status });
        state.observeCompaction('item/started', compact());
        expect(state.report(true).compacting).not.toBe(true);
    });
    it.each(['idle', 'notLoaded', 'systemError'])('clears on native %s', type => {
        const state = tracker();
        state.observeCompaction('item/started', compact());
        state.acceptStatus({ type });
        expect(state.report(true).compacting).not.toBe(true);
    });
    it('clears on transport loss and never publishes a disconnected compaction', () => {
        const state = tracker();
        state.observeCompaction('item/started', compact());
        expect(state.report(false).compacting).not.toBe(true);
        state.disconnected();
        state.acceptStatus({ type: 'active' });
        expect(state.report(true).compacting).not.toBe(true);
    });
    it('keeps a live item through same-turn history reads without inferring compaction from old history', () => {
        const state = tracker();
        state.observeCompaction('item/started', compact());
        state.snapshot({ status: { type: 'active' } }, [{ id: 'turn', status: 'inProgress' }]);
        expect(state.report(true).compacting).toBe(true);
        state.observeCompaction('item/completed', compact());
        state.snapshot({ status: { type: 'active' } }, [{ id: 'turn', status: 'inProgress', items: [compact().item] }]);
        expect(state.report(true).compacting).not.toBe(true);
    });
});
