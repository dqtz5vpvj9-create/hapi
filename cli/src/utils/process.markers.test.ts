import { afterEach, describe, expect, it, vi } from 'vitest';
const queryMock = vi.hoisted(() => vi.fn());
vi.mock('./windowsProcessProbe', () => ({ queryWindowsProcessGenerations: queryMock }));
import { getWindowsProcessStartMarkers, getProcessStartMarkerAsync } from './process';
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
    it('uses the asynchronous native query for Windows startup markers', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            queryMock.mockResolvedValue(new Map([[12, 'generation']]));
            expect(await getProcessStartMarkerAsync(12)).toBe('generation');
            queryMock.mockResolvedValue(new Map());
            expect(await getProcessStartMarkerAsync(12)).toBeNull();
            queryMock.mockRejectedValue(new Error('OpenProcess denied'));
            await expect(getProcessStartMarkerAsync(12)).rejects.toThrow('OpenProcess denied');
        } finally { Object.defineProperty(process, 'platform', platform); }
    });
});
