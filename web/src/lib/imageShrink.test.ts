import { afterEach, describe, expect, it, vi } from 'vitest'
import { shrinkImageFile } from './imageShrink'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('shrinkImageFile', () => {
    it('passes non-image files through untouched', async () => {
        const file = new File([new Uint8Array(4 * 1024 * 1024)], 'notes.pdf', { type: 'application/pdf' })
        await expect(shrinkImageFile(file)).resolves.toBe(file)
    })

    it('passes images under the shrink threshold through untouched', async () => {
        const file = new File([new Uint8Array(64 * 1024)], 'small.png', { type: 'image/png' })
        await expect(shrinkImageFile(file)).resolves.toBe(file)
    })

    it('re-encodes an oversized screenshot into a smaller file', async () => {
        const bitmap = { width: 4000, height: 3000, close: vi.fn() }
        vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,AAAA')
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
            callback(new Blob([new Uint8Array(1024)], { type: 'image/webp' }))
        })

        const original = new File([new Uint8Array(3 * 1024 * 1024)], 'screenshot.png', { type: 'image/png' })
        const shrunk = await shrinkImageFile(original)

        expect(shrunk).not.toBe(original)
        expect(shrunk.type).toBe('image/webp')
        expect(shrunk.name).toBe('screenshot.webp')
        expect(shrunk.size).toBeLessThan(original.size)
        expect(bitmap.close).toHaveBeenCalled()
    })
})
