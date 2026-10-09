import { afterEach, describe, expect, it, vi } from 'vitest';
const queryMock = vi.hoisted(() => vi.fn());
vi.mock('./windowsProcessProbe', () => ({ queryWindowsProcessGenerations: queryMock }));
import { getWindowsProcessStartMarkers } from './process';
afterEach(() => queryMock.mockReset());
describe('Windows runtime generation batch', () => {
    it('queries distinct valid DWORD PIDs and preserves exact generation markers', async () => {
        const markers = new Map([[12, '2026-10-07T12:57:37.2023620Z']]);
        queryMock.mockResolvedValue(markers);
        expect(await getWindowsProcessStartMarkers([12, 13, 12, 0, -1, NaN, 1.5, 0x100000000])).toBe(markers);
        expect(queryMock).toHaveBeenCalledExactlyOnceWith([12, 13]);
    });
    it('does not launch a helper for an empty batch', async () => {
        expect(await getWindowsProcessStartMarkers([])).toEqual(new Map());
        expect(queryMock).not.toHaveBeenCalled();
    });
    it('propagates OS query failures instead of accepting runtime identities', async () => {
        queryMock.mockRejectedValue(new Error('OpenProcess denied'));
        await expect(getWindowsProcessStartMarkers([12])).rejects.toThrow('OpenProcess denied');
    });
});
