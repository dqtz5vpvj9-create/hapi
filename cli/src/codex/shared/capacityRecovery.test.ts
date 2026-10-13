import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapacityRecovery, isCapacityError, type CapacityContinuation } from './capacityRecovery';
import { NativeRuntimeStateTracker } from './execution';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());
function fixture() {
    const host = { inspect: vi.fn(async () => true), continue: vi.fn(async (): Promise<CapacityContinuation> => 'retry-turn'),
        interrupt: vi.fn(async () => {}), publish: vi.fn(), random: () => 0 };
    return { host, recovery: new CapacityRecovery(host) };
}
describe('capacity classification', () => {
    it('accepts structured overload and exact legacy text, never generic errors or contradictory codes', () => {
        expect(isCapacityError({ codexErrorInfo: 'serverOverloaded', message: 'Reconnecting...' })).toBe(true);
        expect(isCapacityError({ message: 'Selected model is at capacity. Please try a different model.' })).toBe(true);
        for (const error of [{ message: 'Quota exceeded' }, { message: 'HTTP 503' }, { message: 'HTTP 429' },
            { message: 'Selected model is at capacity', codexErrorInfo: 'usageLimitExceeded' },
            { message: 'Selected model is at capacity because your authentication failed' }]) expect(isCapacityError(error)).toBe(false);
    });
});
describe('single-owner continuation', () => {
    it('waits exponentially, stays bounded, and validates immediately before every dispatch', async () => {
        const f = fixture();
        for (let attempt = 1; attempt <= 5; attempt++) {
            const id = attempt === 1 ? 'first' : 'retry-turn-' + (attempt - 1);
            f.host.continue.mockResolvedValue('retry-turn-' + attempt);
            await f.recovery.failed(id);
            const delay = Math.min(300_000, 30_000 * 2 ** (attempt - 1));
            expect(f.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', attempt, retryAt: Date.now() + delay }));
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(f.host.continue).toHaveBeenCalledTimes(attempt - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(f.host.continue).toHaveBeenCalledTimes(attempt);
        }
        await f.recovery.failed('retry-turn-5');
        expect(f.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', reason: 'exhausted' }));
        expect(f.host.inspect).toHaveBeenNthCalledWith(3, 'retry-turn-1', true);
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.host.continue).toHaveBeenCalledTimes(5);
    });
    it.each(['start-before-ack', 'ack-before-start', 'terminal-before-ack'] as const)('retains the committed anchor and budget with %s', async order => {
        const f = fixture();
        let resolve!: (id: string) => void;
        f.host.continue.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        if (order !== 'ack-before-start') f.recovery.started('retry-turn');
        const failure = order === 'terminal-before-ack' ? f.recovery.failed('retry-turn') : undefined;
        resolve('retry-turn'); await vi.advanceTimersByTimeAsync(0);
        if (order === 'ack-before-start') f.recovery.started('retry-turn');
        // Duplicate native start must not reset this chain.
        f.recovery.started('retry-turn');
        if (failure) await failure; else await f.recovery.failed('retry-turn');
        expect(f.host.inspect).toHaveBeenLastCalledWith('retry-turn', true);
        expect(f.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', attempt: 2, retryAt: Date.now() + 60_000 }));
    });
    it('deduplicates terminal events and yields ownership to native retries', async () => {
        const f = fixture(); await f.recovery.failed('turn'); await f.recovery.failed('turn');
        expect(f.host.inspect).toHaveBeenCalledTimes(1);
        f.recovery.nativeRetry(); await vi.advanceTimersByTimeAsync(60_000);
        expect(f.host.continue).not.toHaveBeenCalled();
    });
    it.each(['cancel', 'started'] as const)('%s invalidates a waiting continuation', async action => {
        const f = fixture(); await f.recovery.failed('turn'); f.recovery[action]();
        await vi.advanceTimersByTimeAsync(60_000); expect(f.host.continue).not.toHaveBeenCalled();
    });
    it('fails closed without committed input, latest turn, or empty queue proof', async () => {
        const f = fixture(); f.host.inspect.mockResolvedValue(false); await f.recovery.failed('turn');
        expect(f.host.publish).toHaveBeenLastCalledWith({ turnId: 'turn', phase: 'failed', reason: 'unverified' });
        await vi.advanceTimersByTimeAsync(60_000); expect(f.host.continue).not.toHaveBeenCalled();
    });
    it('cancels if state changed during the last read', async () => {
        const f = fixture(); await f.recovery.failed('turn');
        f.host.inspect.mockImplementation(async () => { f.recovery.cancel(); return true; });
        await vi.advanceTimersByTimeAsync(30_000); expect(f.host.continue).not.toHaveBeenCalled();
    });
    it('never retries a timeout or active-turn rejection', async () => {
        const f = fixture(); f.host.continue.mockRejectedValue(new Error('indeterminate timeout'));
        await f.recovery.failed('turn'); await vi.advanceTimersByTimeAsync(30_000);
        expect(f.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'unconfirmed' }));
        await vi.advanceTimersByTimeAsync(1_000_000); expect(f.host.continue).toHaveBeenCalledTimes(1);
    });
    it('targets only its acknowledged continuation when Stop races an in-flight start', async () => {
        const f = fixture(); let resolve!: (value: string) => void;
        f.host.continue.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
        await f.recovery.failed('turn'); await vi.advanceTimersByTimeAsync(30_000);
        f.recovery.cancel(); resolve('our-turn'); await vi.advanceTimersByTimeAsync(0);
        expect(f.host.interrupt).toHaveBeenCalledExactlyOnceWith('our-turn');
        expect(f.host.continue).toHaveBeenCalledTimes(1);
    });
    it('suppresses late terminal events after Stop without changing ordinary cancellation', async () => {
        const stopped = fixture(); stopped.recovery.suppress('stopped-turn');
        await stopped.recovery.failed('stopped-turn');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stopped.host.inspect).not.toHaveBeenCalled();
        expect(stopped.host.continue).not.toHaveBeenCalled();

        const committed = fixture(); committed.recovery.cancel();
        await committed.recovery.failed('committed-turn');
        expect(committed.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', attempt: 1 }));
    });
    it('keeps suppression tombstones bounded', async () => {
        const f = fixture();
        for (let i = 0; i < 65; i++) f.recovery.suppress('turn-' + i);
        await f.recovery.failed('turn-64'); expect(f.host.inspect).not.toHaveBeenCalled();
        await f.recovery.failed('turn-0'); expect(f.host.inspect).toHaveBeenCalledExactlyOnceWith('turn-0', false);
    });
});
describe('native goal continuation', () => {
    it.each(['start-before-ack', 'ack-before-start', 'terminal-before-ack'] as const)('retains the goal retry budget with %s', async order => {
        const f = fixture();
        let resolve!: (receipt: CapacityContinuation) => void;
        const cancel = vi.fn(async () => {});
        f.host.continue.mockImplementation(() => new Promise<CapacityContinuation>(done => { resolve = done; }));
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        expect(f.recovery.isDispatching).toBe(true);
        if (order !== 'ack-before-start') f.recovery.started('goal-turn', true);
        const failure = order === 'terminal-before-ack' ? f.recovery.failed('goal-turn') : undefined;
        resolve({ goal: true, cancel }); await vi.advanceTimersByTimeAsync(0);
        expect(f.recovery.isDispatching).toBe(false);
        expect(f.recovery.ownsGoalResume).toBe(order === 'ack-before-start');
        if (order === 'ack-before-start') f.recovery.started('goal-turn', true);
        expect(f.recovery.ownsGoalResume).toBe(false);
        f.recovery.started('goal-turn');
        if (failure) await failure; else await f.recovery.failed('goal-turn');
        expect(f.host.inspect).toHaveBeenLastCalledWith('goal-turn', true);
        expect(f.host.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', attempt: 2, retryAt: Date.now() + 60_000 }));
        expect(cancel).not.toHaveBeenCalled();
    });
    it('exhausts the same finite budget across resumed goal turns', async () => {
        const f = fixture();
        f.host.continue.mockResolvedValue({ goal: true, cancel: async () => {} });
        for (let attempt = 1; attempt <= 5; attempt++) {
            await f.recovery.failed(attempt === 1 ? 'original' : 'goal-turn-' + (attempt - 1));
            await vi.advanceTimersByTimeAsync(Math.min(300_000, 30_000 * 2 ** (attempt - 1)));
            f.recovery.started('goal-turn-' + attempt, true);
            expect(f.host.continue).toHaveBeenCalledTimes(attempt);
        }
        await f.recovery.failed('goal-turn-5');
        expect(f.host.publish).toHaveBeenLastCalledWith({ turnId: 'goal-turn-5', phase: 'failed', reason: 'exhausted' });
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.host.continue).toHaveBeenCalledTimes(5);
    });
    it.each(['acknowledged', 'proved-start', 'unproved-start', 'no-start'] as const)('cancels the same goal and interrupts only a proven turn with %s', async association => {
        const f = fixture();
        let resolve!: (receipt: CapacityContinuation) => void;
        const cancel = vi.fn(async () => {});
        f.host.continue.mockImplementation(() => new Promise<CapacityContinuation>(done => { resolve = done; }));
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        if (association === 'proved-start') f.recovery.started('goal-turn', true);
        if (association === 'unproved-start') f.recovery.started('unrelated-turn');
        f.recovery.suppress('original');
        resolve({ goal: true, ...(association === 'acknowledged' ? { turnId: 'goal-turn' } : {}), cancel });
        await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(f.recovery.isDispatching).toBe(false);
        expect(f.recovery.ownsGoalResume).toBe(false);
        if (association === 'acknowledged' || association === 'proved-start') {
            expect(f.host.interrupt).toHaveBeenCalledExactlyOnceWith('goal-turn');
            const inspections = f.host.inspect.mock.calls.length;
            await f.recovery.failed('goal-turn');
            expect(f.host.inspect).toHaveBeenCalledTimes(inspections);
        } else expect(f.host.interrupt).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.host.continue).toHaveBeenCalledTimes(1);
    });
    it('does not associate a start first seen after cancellation with the stale goal request', async () => {
        const f = fixture();
        let resolve!: (receipt: CapacityContinuation) => void;
        const cancel = vi.fn(async () => {});
        f.host.continue.mockImplementation(() => new Promise<CapacityContinuation>(done => { resolve = done; }));
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        f.recovery.suppress('original'); f.recovery.started('new-intent-turn', true);
        resolve({ goal: true, cancel }); await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(f.host.interrupt).not.toHaveBeenCalled();
    });
    it.each(['turn', 'goal'] as const)('suppresses a post-Stop failure awaiting its stale %s ACK before cleanup finishes', async kind => {
        const f = fixture();
        let resolve!: (receipt: CapacityContinuation) => void;
        let finishCleanup!: () => void;
        const cleanup = new Promise<void>(done => { finishCleanup = done; });
        const cancel = vi.fn(() => cleanup);
        f.host.continue.mockImplementation(() => new Promise<CapacityContinuation>(done => { resolve = done; }));
        if (kind === 'turn') f.host.interrupt.mockImplementation(() => cleanup);
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        f.recovery.suppress('original');
        f.recovery.started('late-turn', true);
        const failure = f.recovery.failed('late-turn');
        resolve(kind === 'turn' ? 'late-turn' : { goal: true, turnId: 'late-turn', cancel });
        await vi.advanceTimersByTimeAsync(0); await failure;
        expect(f.recovery.isDispatching).toBe(true);
        expect(f.host.inspect).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.host.continue).toHaveBeenCalledTimes(1);
        finishCleanup(); await vi.advanceTimersByTimeAsync(0);
        expect(f.host.interrupt).toHaveBeenCalledExactlyOnceWith('late-turn');
        expect(f.recovery.isDispatching).toBe(false);
    });
    it('requires root proof before treating the first started goal turn as a continuation', async () => {
        const f = fixture();
        f.host.continue.mockResolvedValue({ goal: true, cancel: async () => {} });
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        f.recovery.started('unrelated-turn');
        expect(f.recovery.ownsGoalResume).toBe(false);
        f.host.inspect.mockResolvedValue(false);
        await f.recovery.failed('unrelated-turn');
        expect(f.host.inspect).toHaveBeenLastCalledWith('unrelated-turn', false);
        expect(f.host.publish).toHaveBeenLastCalledWith({ turnId: 'unrelated-turn', phase: 'failed', reason: 'unverified' });
    });
    it('never retries an unknown goal ACK even when its proved turn fails before the request rejects', async () => {
        const f = fixture();
        let reject!: (error: Error) => void;
        f.host.continue.mockImplementation(() => new Promise<CapacityContinuation>((_resolve, fail) => { reject = fail; }));
        await f.recovery.failed('original'); await vi.advanceTimersByTimeAsync(30_000);
        f.recovery.started('goal-turn', true);
        const failure = f.recovery.failed('goal-turn');
        reject(new Error('unknown goal/set outcome')); await vi.advanceTimersByTimeAsync(0); await failure;
        expect(f.host.publish).toHaveBeenLastCalledWith({ turnId: 'original', phase: 'failed', reason: 'unconfirmed' });
        expect(f.recovery.isDispatching).toBe(false);
        expect(f.recovery.ownsGoalResume).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(f.host.continue).toHaveBeenCalledTimes(1);
        expect(f.host.inspect).toHaveBeenCalledTimes(2);
    });
});
describe('observed native capacity state', () => {
    it('scopes errors to the current turn and clears after progress or a replacement error', () => {
        const t = new NativeRuntimeStateTracker('owner', 'generation'); t.started({ id: 'current' });
        const error = { codexErrorInfo: 'serverOverloaded' };
        t.error({ turnId: 'old', error, willRetry: true }); expect(t.report(true).capacityRecovery).toBeNull();
        t.error({ turnId: 'current', error, willRetry: true }); expect(t.report(true).capacityRecovery?.phase).toBe('retrying');
        t.error({ turnId: 'current', error: { codexErrorInfo: 'usageLimitExceeded' }, willRetry: false });
        expect(t.report(true).capacityRecovery).toBeNull();
        t.error({ turnId: 'current', error, willRetry: true }); t.progress('current'); expect(t.report(true).capacityRecovery).toBeNull();
    });
    it('never resurrects retry state from old terminal events, and clears on stop/disconnect/new turn', () => {
        const t = new NativeRuntimeStateTracker('owner', 'generation'); const error = { codexErrorInfo: 'serverOverloaded' };
        t.started({ id: 'first' }); t.error({ turnId: 'first', error, willRetry: true });
        t.completed({ id: 'first', status: 'interrupted' }); expect(t.report(true).capacityRecovery).toBeNull();
        t.error({ turnId: 'first', error, willRetry: true }); expect(t.report(true).capacityRecovery).toBeNull();
        t.started({ id: 'second' }); t.completed({ id: 'first', status: 'failed', error }); expect(t.report(true).capacityRecovery).toBeNull();
        t.error({ turnId: 'second', error, willRetry: true }); expect(t.report(false).capacityRecovery).toBeNull();
        t.disconnected(); expect(t.report(true).capacityRecovery).toBeNull();
    });
});
