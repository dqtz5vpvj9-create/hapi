import { describe, expect, it } from 'vitest'
import { documentDownloadAvailable } from './DocumentSurface'

describe('documentDownloadAvailable', () => {
    it('allows office downloads before the preview is ready', () => {
        expect(documentDownloadAvailable({ dirty: false }, true, false)).toBe(true)
    })

    it('allows artifact downloads before preview data is loaded', () => {
        expect(documentDownloadAvailable({ dirty: false }, false, true)).toBe(true)
    })

    it('waits for text bytes or a draft when there is no direct source path', () => {
        expect(documentDownloadAvailable({ dirty: false }, false, false)).toBe(false)
        expect(documentDownloadAvailable({ dirty: false, blob: new Blob(['x']) }, false, false)).toBe(true)
        expect(documentDownloadAvailable({ dirty: true }, false, false)).toBe(true)
    })
})
