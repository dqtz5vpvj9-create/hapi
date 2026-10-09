import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { ApiClient } from '@/api/client'

const mockApi = {
    fetchScratchlistAttachmentBlob: vi.fn(),
    uploadFile: vi.fn(),
} as unknown as ApiClient
const mockSessionId = 'sess-test'

/**
 * Regression test for upstream review on PR #798 (HAPI Bot follow-up
 * after b256fe5):
 *
 *   > Found one major issue: promoting a scratchlist item to the
 *   > composer keeps scratchlist mode enabled, so the next send re-adds
 *   > it to the scratchlist instead of sending to chat.
 *
 * The fix is for ScratchlistDrawerHost to call `onExitScratchlistMode`
 * whenever it promotes an entry to the composer (since promoting means
 * "I want to send this for real now"). This test mocks the assistant-ui
 * runtime hook and asserts both the setText call AND the exit-mode call
 * fire when the operator clicks promote-to-composer.
 *
 * Promote-to-queue exits scratchlist mode after a successful send so the
 * operator can continue normal chat (issue #959). Rejected sends keep mode
 * on so the entry stays and the operator can retry.
 */

const composerState = { text: '', attachments: [] as Array<{ id: string }> }
const setText = vi.fn((text: string) => { composerState.text = text })
const addAttachment = vi.fn<(file: File) => Promise<void>>()
vi.mock('@assistant-ui/react', () => ({
    useAui: () => ({
        composer: () => ({ setText, addAttachment, getState: () => composerState }),
    }),
}))

import { ScratchlistDrawerHost } from './SessionChat'

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return { text: 'note', createdAt: 1000, ...overrides }
}

afterEach(() => {
    cleanup()
    setText.mockClear()
    addAttachment.mockReset()
    composerState.text = ''
    composerState.attachments = []
    vi.restoreAllMocks()
})

describe('ScratchlistDrawerHost.onPromoteToComposer', () => {
    function renderCopy() {
        const onSend = vi.fn(async () => true)
        const onExitScratchlistMode = vi.fn()
        const onDelete = vi.fn()
        render(<I18nProvider><ScratchlistDrawerHost
            sessionId={mockSessionId} api={mockApi}
            entries={[makeEntry({ id: 'old', text: 'parked requirement' })]}
            onMove={vi.fn()} onDelete={onDelete} onSend={onSend}
            onExitScratchlistMode={onExitScratchlistMode}
        /></I18nProvider>)
        return { onSend, onExitScratchlistMode, onDelete }
    }

    it('lets the user cancel copying without changing text, attachments, mode or the held entry', () => {
        composerState.text = 'new requirement'
        composerState.attachments = [{ id: 'new-image' }]
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const callbacks = renderCopy()
        fireEvent.click(screen.getByRole('button', { name: 'Copy into composer' }))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(composerState).toEqual({ text: 'new requirement', attachments: [{ id: 'new-image' }] })
        expect(setText).not.toHaveBeenCalled()
        expect(callbacks.onExitScratchlistMode).not.toHaveBeenCalled()
        expect(callbacks.onSend).not.toHaveBeenCalled()
        expect(callbacks.onDelete).not.toHaveBeenCalled()
    })

    it('merges after explicit confirmation and preserves the current attachment and held entry', () => {
        composerState.text = 'new requirement'
        composerState.attachments = [{ id: 'new-image' }]
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        const callbacks = renderCopy()
        fireEvent.click(screen.getByRole('button', { name: 'Copy into composer' }))
        expect(composerState).toEqual({
            text: 'new requirement\n\nparked requirement', attachments: [{ id: 'new-image' }],
        })
        expect(callbacks.onExitScratchlistMode).toHaveBeenCalledTimes(1)
        expect(callbacks.onSend).not.toHaveBeenCalled()
        expect(callbacks.onDelete).not.toHaveBeenCalled()
    })

    it('also protects an attachment-only draft and does not double the exact restored text', async () => {
        composerState.attachments = [{ id: 'new-image' }]
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        renderCopy()
        const copy = screen.getByRole('button', { name: 'Copy into composer' })
        fireEvent.click(copy)
        expect(setText).not.toHaveBeenCalled()
        await waitFor(() => expect(copy).not.toBeDisabled())
        confirm.mockReturnValue(true)
        fireEvent.click(copy)
        fireEvent.click(copy)
        expect(composerState.text).toBe('parked requirement')
        expect(composerState.attachments).toEqual([{ id: 'new-image' }])
    })

    it('copies held image and text into an empty composer, then merges a new draft without duplicating that image', async () => {
        const { createAttachmentAdapter } = await import('@/lib/attachmentAdapter')
        const api = {
            fetchScratchlistAttachmentBlob: vi.fn(async () => new Blob(['held image'], { type: 'image/png' })),
            uploadFile: vi.fn(async () => ({ success: true, path: '/uploads/held.png' })),
        }
        const adapter = createAttachmentAdapter(api as unknown as ApiClient, mockSessionId)
        addAttachment.mockImplementation(async (file) => {
            const additions = adapter.add({ file })
            if (!('next' in additions)) throw new Error('Expected upload progress')
            for await (const attachment of additions) {
                const current = composerState.attachments.filter((item) => item.id !== attachment.id)
                composerState.attachments = [...current, attachment]
            }
        })
        const entry = makeEntry({ id: 'held', text: 'held requirement', attachments: [{
            id: 'hub-image', filename: 'held.png', mimeType: 'image/png', size: 10,
            path: 'hapi-hub:scratchlist/default/sess-test/hub-image-held.png',
        }] })
        const onSend = vi.fn(async () => true)
        const onDelete = vi.fn()
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
        render(<I18nProvider><ScratchlistDrawerHost
            sessionId={mockSessionId} api={api as unknown as ApiClient} entries={[entry]}
            onMove={vi.fn()} onDelete={onDelete} onSend={onSend} onExitScratchlistMode={vi.fn()}
        /></I18nProvider>)
        const copy = screen.getByRole('button', { name: 'Copy into composer' })
        fireEvent.click(copy)
        await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(composerState.attachments[0]).toMatchObject({ path: '/uploads/held.png' }))
        expect(confirm).not.toHaveBeenCalled()
        expect(composerState.text).toBe('held requirement')
        composerState.text = 'new unsent requirement'
        fireEvent.click(copy)
        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
        expect(composerState.text).toBe('new unsent requirement\n\nheld requirement')
        expect(composerState.attachments).toHaveLength(1)
        expect(addAttachment).toHaveBeenCalledTimes(1)
        expect(api.uploadFile).toHaveBeenCalledTimes(1)
        expect(onDelete).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(entry.attachments).toHaveLength(1)
    })

    it('exits scratchlist mode AND sets composer text when an entry is promoted to composer', () => {
        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'queued thought' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        // The drawer renders a "promote to composer" button per entry.
        // Match by aria-label so we do not depend on icon/glyph copy.
        const promoteButtons = screen.getAllByRole('button', { name: /composer|edit/i })
        expect(promoteButtons.length).toBeGreaterThan(0)
        fireEvent.click(promoteButtons[0]!)

        expect(setText).toHaveBeenCalledWith('queued thought')
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        // Promote-to-composer must NOT call onSend (that's promote-to-queue).
        expect(onSend).not.toHaveBeenCalled()
    })

    it('exits scratchlist mode when an entry is promoted to queue and the send is accepted', async () => {
        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'send-to-queue text' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        const queueButtons = screen.getAllByRole('button', { name: /queue|send/i })
        expect(queueButtons.length).toBeGreaterThan(0)
        fireEvent.click(queueButtons[0]!)

        await waitFor(() => expect(onSend).toHaveBeenCalledWith(
            'send-to-queue text',
            undefined,
            undefined,
            'queue',
        ))
        expect(onExitScratchlistMode).toHaveBeenCalledTimes(1)
        expect(setText).not.toHaveBeenCalled()
    })

    it('does NOT exit scratchlist mode when promote-to-queue send is rejected', async () => {
        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => false)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'send-to-queue text' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        const queueButtons = screen.getAllByRole('button', { name: /queue|send/i })
        fireEvent.click(queueButtons[0]!)

        await waitFor(() => expect(onSend).toHaveBeenCalledWith(
            'send-to-queue text',
            undefined,
            undefined,
            'queue',
        ))
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
    })
})

describe('ScratchlistDrawer copy-to-clipboard action', () => {
    it('writes the entry text to the clipboard and flips the button label to "Copied!" briefly', async () => {
        // Mock navigator.clipboard so safeCopyToClipboard's primary path
        // resolves successfully (it tries this before the execCommand fallback).
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        const onExitScratchlistMode = vi.fn()
        const onSend = vi.fn(async () => true)
        const onMove = vi.fn()
        const onDelete = vi.fn()

        render(
            <I18nProvider>
                <ScratchlistDrawerHost
                    sessionId={mockSessionId}
                    api={mockApi}
                    entries={[makeEntry({ id: 'e1', text: 'copy this' })]}
                    onMove={onMove}
                    onDelete={onDelete}
                    onSend={onSend}
                    onExitScratchlistMode={onExitScratchlistMode}
                />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByRole('button', { name: 'Copy text to clipboard (not images)' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy this'))
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy(),
        )

        // Copy must NOT mutate the list — entry stays, no other handlers fire.
        expect(onDelete).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(setText).not.toHaveBeenCalled()
        expect(onExitScratchlistMode).not.toHaveBeenCalled()
    })
})
