import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ShareTurnDialog } from './ShareTurnDialog'

const renderer = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('html2canvas-pro', () => ({ default: renderer.render }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
// Keep the actual ShareTurnDialog and its asynchronous raster pipeline. The
// shell only supplies a deterministic close event; App coverage uses Radix.
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => open ? (
        <div><button onClick={() => onOpenChange(false)}>Close dialog</button>{children}</div>
    ) : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve']
    let reject!: Deferred<T>['reject']
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const snapshotsA = [{ html: '<div>source A</div>', text: 'source A', role: 'assistant' as const }]
const snapshotsB = [{ html: '<div>source B</div>', text: 'source B', role: 'assistant' as const }]
const metadataItems: [] = []
let captures: Deferred<HTMLCanvasElement>[]
let clipboard: Deferred<void>
const createObjectURL = vi.fn(() => 'blob:share-turn-test')
const revokeObjectURL = vi.fn()
const clipboardWrite = vi.fn()
const nativeShare = vi.fn()
let anchorClick: MockInstance<() => void>
const onClose = vi.fn()

function view(isOpen = true, source: 'A' | 'B' = 'A') {
    return <ShareTurnDialog isOpen={isOpen} title={`Session ${source}`} metadataItems={metadataItems}
        sourceSnapshots={source === 'A' ? snapshotsA : snapshotsB} onClose={onClose} />
}
function button(name: string) { return screen.getByRole('button', { name: `shareTurn.${name}` }) }
async function waitCaptures(count: number) {
    await waitFor(() => expect(captures).toHaveLength(count))
}
async function finishCapture(index: number, error?: Error) {
    await act(async () => {
        if (error) captures[index].reject(error)
        else {
            const canvas = document.createElement('canvas')
            canvas.toBlob = (callback) => callback(new Blob([`capture-${index}`], { type: 'image/png' }))
            captures[index].resolve(canvas)
        }
    })
}
async function startPendingAction(action: 'download' | 'copy') {
    await waitCaptures(1) // Eager preview render remains pending.
    fireEvent.click(button(action))
    await waitCaptures(2) // Active action owns its own render.
}
async function openPendingB(rerender: (ui: ReturnType<typeof view>) => void, closeFirst = true) {
    if (closeFirst) rerender(view(false))
    rerender(view(true, 'B'))
    await waitCaptures(3)
    fireEvent.click(button('download'))
    await waitCaptures(4)
    expect(button('saving')).toBeDisabled()
}

beforeEach(() => {
    captures = []
    clipboard = deferred<void>()
    renderer.render.mockImplementation(() => {
        const capture = deferred<HTMLCanvasElement>()
        captures.push(capture)
        return capture.promise
    })
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    clipboardWrite.mockReset().mockImplementation(() => clipboard.promise)
    nativeShare.mockReset().mockImplementation(() => clipboard.promise)
    onClose.mockClear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        queueMicrotask(() => callback(0))
        return 1
    })
    vi.stubGlobal('ClipboardItem', class { constructor(_items: Record<string, Blob>) {} })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: clipboardWrite } })
    Object.defineProperty(navigator, 'share', { configurable: true, value: nativeShare })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(async () => {
    // Settle the mocked renderer so its real iframe cleanup runs in every case.
    await act(async () => {
        for (const capture of captures) capture.reject(new Error('test cleanup'))
        clipboard.resolve()
    })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    renderer.render.mockReset()
})

describe('ShareTurnDialog asynchronous action lifetime', () => {
    it.each(['download', 'copy'] as const)('invalidates pending %s synchronously on Close', async (action) => {
        render(view())
        await startPendingAction(action)
        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
        expect(onClose).toHaveBeenCalledOnce()
        // Parent closure can be deferred; the Close event itself invalidates it.
        await finishCapture(1)
        expect(anchorClick).not.toHaveBeenCalled()
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(clipboardWrite).not.toHaveBeenCalled()
    })

    it.each(['download', 'copy'] as const)('does not start a late %s after unmount', async (action) => {
        const mounted = render(view())
        await startPendingAction(action)
        mounted.unmount()
        await finishCapture(1)
        expect(anchorClick).not.toHaveBeenCalled()
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(clipboardWrite).not.toHaveBeenCalled()
    })

    it.each(['resolve', 'reject'] as const)('keeps B busy when closed A render settles with %s', async (outcome) => {
        const mounted = render(view())
        await startPendingAction('download')
        await openPendingB(mounted.rerender)
        await finishCapture(1, outcome === 'reject' ? new Error('stale A failure') : undefined)
        expect(button('saving')).toBeDisabled()
        expect(screen.queryByText('stale A failure')).not.toBeInTheDocument()
        expect(anchorClick).not.toHaveBeenCalled()
        await finishCapture(3)
        await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toMatch(/^HAPI-Session B-/)
        expect(button('download')).toBeEnabled()
    })

    it('invalidates a pending copy when snapshots are replaced without unmounting', async () => {
        const mounted = render(view())
        await startPendingAction('copy')
        await openPendingB(mounted.rerender, false)
        await finishCapture(1)
        expect(clipboardWrite).not.toHaveBeenCalled()
        expect(button('saving')).toBeDisabled()
        await finishCapture(3)
        await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
        expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toMatch(/^HAPI-Session B-/)
    })

    it.each([['copy', 'resolve'], ['copy', 'reject'], ['share', 'resolve'], ['share', 'reject']] as const)('isolates an already-started prepared %s %s from reopened B', async (action, outcome) => {
        const mounted = render(view())
        await waitCaptures(1)
        await finishCapture(0)
        await waitFor(() => expect(button('share')).toBeEnabled())
        fireEvent.click(button(action))
        const sentAction = action === 'copy' ? clipboardWrite : nativeShare
        expect(sentAction).toHaveBeenCalledOnce()
        mounted.rerender(view(false))
        mounted.rerender(view(true, 'B'))
        await waitCaptures(2)
        fireEvent.click(button('download'))
        await waitCaptures(3)
        await act(async () => {
            if (outcome === 'resolve') clipboard.resolve()
            else clipboard.reject(new Error('stale clipboard failure'))
        })
        expect(button('saving')).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'shareTurn.copied' })).not.toBeInTheDocument()
        expect(screen.queryByText('stale clipboard failure')).not.toBeInTheDocument()
        await finishCapture(2)
        await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
        expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toMatch(/^HAPI-Session B-/)
        expect(sentAction).toHaveBeenCalledOnce()
    })

    it.each(['resolve', 'reject'] as const)('isolates a non-prepared clipboard %s after it starts', async (outcome) => {
        const mounted = render(view())
        await startPendingAction('copy')
        await finishCapture(1)
        expect(clipboardWrite).toHaveBeenCalledOnce()
        await openPendingB(mounted.rerender)
        await act(async () => {
            if (outcome === 'resolve') clipboard.resolve()
            else clipboard.reject(new Error('stale unprepared copy failure'))
        })
        expect(button('saving')).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'shareTurn.copied' })).not.toBeInTheDocument()
        expect(screen.queryByText('stale unprepared copy failure')).not.toBeInTheDocument()
        await finishCapture(3)
        await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
        expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toMatch(/^HAPI-Session B-/)
        expect(clipboardWrite).toHaveBeenCalledOnce()
    })

    it('still reports an error from the current action and allows retry', async () => {
        render(view())
        await startPendingAction('download')
        await finishCapture(1, new Error('current render failed'))
        await waitFor(() => expect(screen.getByText('current render failed')).toBeInTheDocument())
        expect(button('download')).toBeEnabled()
        expect(anchorClick).not.toHaveBeenCalled()
        fireEvent.click(button('download'))
        await waitCaptures(3)
        await finishCapture(2)
        await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
    })
})
