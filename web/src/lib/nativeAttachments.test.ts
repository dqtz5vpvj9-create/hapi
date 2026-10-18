import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickedFile } from '@capawesome/capacitor-file-picker'
import { MAX_UPLOAD_BYTES } from '@/lib/attachmentAdapter'
import { isNativeAttachmentCancellation, NativeAttachmentError, pickNativeAttachments } from './nativeAttachments'

const picker = vi.hoisted(() => ({ pickImages: vi.fn(), pickFiles: vi.fn() }))
vi.mock('@capawesome/capacitor-file-picker', () => ({ FilePicker: picker }))

function selected(overrides: Partial<PickedFile> = {}): PickedFile {
    return {
        name: '笔记 original.txt', mimeType: 'text/plain', size: 5, modifiedAt: 1234,
        path: 'content://selected/notes', webPath: 'https://localhost/_capacitor_content_/selected/notes',
        ...overrides,
    }
}

function readBytes(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(file)
    })
}

const fetchFile = vi.fn<typeof fetch>()
beforeEach(() => {
    vi.clearAllMocks()
    picker.pickImages.mockResolvedValue({ files: [selected()] })
    picker.pickFiles.mockResolvedValue({ files: [selected()] })
    fetchFile.mockResolvedValue(new Response('notes', { headers: { 'Content-Type': 'application/octet-stream' } }))
    vi.stubGlobal('fetch', fetchFile)
})
afterEach(() => vi.unstubAllGlobals())

describe('native attachment picker boundary', () => {
    it('preserves selected document bytes, original filename, MIME and modification time', async () => {
        const [file] = await pickNativeAttachments('files')
        expect(picker.pickFiles).toHaveBeenCalledWith({ limit: 0, readData: false })
        expect(picker.pickImages).not.toHaveBeenCalled()
        expect(fetchFile).toHaveBeenCalledWith(selected().webPath, { signal: undefined, credentials: 'omit' })
        expect(file).toMatchObject({ name: '笔记 original.txt', type: 'text/plain', size: 5, lastModified: 1234 })
        expect(Array.from(await readBytes(file))).toEqual(Array.from(new TextEncoder().encode('notes')))
    })

    it('opens the photo picker without transcoding or requesting library permissions', async () => {
        picker.pickImages.mockResolvedValue({ files: [selected({ name: 'IMG_1234.HEIC', mimeType: 'image/heic' })] })
        const [file] = await pickNativeAttachments('photos')
        expect(picker.pickImages).toHaveBeenCalledWith({ limit: 0, readData: false, skipTranscoding: true, ordered: true })
        expect(picker.pickFiles).not.toHaveBeenCalled()
        expect(file.name).toBe('IMG_1234.HEIC')
        expect(file.type).toBe('image/heic')
    })

    it('loads multiple selected files sequentially and preserves picker order', async () => {
        picker.pickFiles.mockResolvedValue({ files: [selected({ name: 'first.txt' }), selected({ name: 'second.txt' })] })
        let completeFirst!: (response: Response) => void
        fetchFile.mockImplementationOnce(() => new Promise(resolve => { completeFirst = resolve }))
        fetchFile.mockResolvedValueOnce(new Response('second'))
        const result = pickNativeAttachments('files')
        await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(1))
        completeFirst(new Response('first'))
        expect((await result).map(file => file.name)).toEqual(['first.txt', 'second.txt'])
        expect(fetchFile).toHaveBeenCalledTimes(2)
    })

    it('rejects any oversized metadata before loading any selected file', async () => {
        picker.pickFiles.mockResolvedValue({ files: [selected(), selected({ name: 'large.bin', size: MAX_UPLOAD_BYTES + 1 })] })
        await expect(pickNativeAttachments('files')).rejects.toMatchObject({ code: 'too-large', fileName: 'large.bin' })
        expect(fetchFile).not.toHaveBeenCalled()
    })

    it.each([undefined, -1, Number.NaN])('checks actual bytes when native size is unknown: %s', async size => {
        picker.pickFiles.mockResolvedValue({ files: [selected({ size: size as number })] })
        fetchFile.mockResolvedValue({ ok: true, headers: new Headers(), body: null,
            blob: async () => ({ size: MAX_UPLOAD_BYTES + 1 }) } as Response)
        await expect(pickNativeAttachments('files')).rejects.toMatchObject({ code: 'too-large' })
    })

    it('stops an oversized stream with no Content-Length before retaining all its bytes', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined)
        const reader = {
            read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(MAX_UPLOAD_BYTES + 1) }),
            cancel, releaseLock: vi.fn(),
        }
        fetchFile.mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => reader } } as unknown as Response)
        await expect(pickNativeAttachments('files')).rejects.toMatchObject({ code: 'too-large' })
        expect(cancel).toHaveBeenCalledOnce()
        expect(reader.read).toHaveBeenCalledOnce()
        expect(reader.releaseLock).toHaveBeenCalledOnce()
    })

    it('rejects an oversized Content-Length before opening the response stream', async () => {
        const getReader = vi.fn()
        const cancel = vi.fn().mockResolvedValue(undefined)
        fetchFile.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Length': String(MAX_UPLOAD_BYTES + 1) }),
            body: { getReader, cancel } } as unknown as Response)
        await expect(pickNativeAttachments('files')).rejects.toMatchObject({ code: 'too-large' })
        expect(getReader).not.toHaveBeenCalled()
        expect(cancel).toHaveBeenCalledOnce()
    })

    it('keeps an empty original file valid', async () => {
        picker.pickFiles.mockResolvedValue({ files: [selected({ size: 0 })] })
        fetchFile.mockResolvedValue(new Response(''))
        const [file] = await pickNativeAttachments('files')
        expect(file.size).toBe(0)
    })

    it('treats only the pinned native cancel response as cancellation', async () => {
        picker.pickImages.mockRejectedValue(new Error('pickFiles canceled.'))
        expect(await pickNativeAttachments('photos')).toEqual([])
        expect(fetchFile).not.toHaveBeenCalled()
        expect(isNativeAttachmentCancellation({ message: 'Permission denied' })).toBe(false)
        expect(isNativeAttachmentCancellation(new Error('The provider canceled its read unexpectedly'))).toBe(false)
    })

    it('propagates native errors instead of replacing them with cancellation', async () => {
        const error = new Error('Selected cloud provider is unavailable')
        picker.pickFiles.mockRejectedValue(error)
        await expect(pickNativeAttachments('files')).rejects.toBe(error)
        expect(fetchFile).not.toHaveBeenCalled()
    })

    it('returns no partial selection when a selected asset cannot be read', async () => {
        picker.pickFiles.mockResolvedValue({ files: [selected(), selected({ name: 'unavailable.txt' })] })
        fetchFile.mockResolvedValueOnce(new Response('notes'))
            .mockResolvedValueOnce(new Response('missing', { status: 404 }))
        await expect(pickNativeAttachments('files')).rejects.toMatchObject({ code: 'unreadable', fileName: 'unavailable.txt' })
    })

    it('reports missing paths rather than creating a placeholder file', async () => {
        picker.pickFiles.mockResolvedValue({ files: [selected({ webPath: undefined })] })
        await expect(pickNativeAttachments('files')).rejects.toBeInstanceOf(NativeAttachmentError)
        expect(fetchFile).not.toHaveBeenCalled()
    })

    it('serializes picker calls across independent attachment buttons', async () => {
        let finish!: (result: { files: PickedFile[] }) => void
        picker.pickFiles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        const first = pickNativeAttachments('files')
        await vi.waitFor(() => expect(picker.pickFiles).toHaveBeenCalledOnce())
        await expect(pickNativeAttachments('photos')).rejects.toMatchObject({ code: 'busy' })
        expect(picker.pickImages).not.toHaveBeenCalled()
        finish({ files: [] })
        expect(await first).toEqual([])
        expect(await pickNativeAttachments('files')).toHaveLength(1)
    })

    it('does not read returned assets after the originating draft has been canceled', async () => {
        const controller = new AbortController()
        let finish!: (result: { files: PickedFile[] }) => void
        picker.pickFiles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        const result = pickNativeAttachments('files', controller.signal)
        await vi.waitFor(() => expect(picker.pickFiles).toHaveBeenCalledOnce())
        controller.abort()
        finish({ files: [selected()] })
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(fetchFile).not.toHaveBeenCalled()
    })
})
