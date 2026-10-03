import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter, type AttachmentAdapter } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { HappyComposer } from './HappyComposer'
import type { PendingSchedule } from './ScheduleTimePicker'
import { ComposerButtons, type ComposerButtonsProps } from './ComposerButtons'

vi.mock('@/themes/glass/GlassScene', async () => ({ ...await import('@/themes/glass/GlassScene'), useGlassLayout: () => true }))
vi.mock('@/lib/use-fue', () => ({ useFue: () => ({ status: 'acknowledged', engage: vi.fn(), dismiss: vi.fn() }) }))
vi.mock('@/hooks/useComposerDraft', () => ({ useComposerDraft: () => ({ complete: true, restoredAny: false, hasStoredAttachments: false }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ isTouch: false, haptic: { impact() {}, notification() {} } }) }))
const adapter: ChatModelAdapter = { async *run() {} }
const noop = () => {}
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const base: ComposerButtonsProps = {
    canSend: true, controlsDisabled: false, showSettingsButton: false, onSettingsToggle: noop,
    expanded: false, onExpandedToggle: noop, showTerminalButton: true, terminalDisabled: false,
    terminalLabel: 'Terminal', onTerminal: noop, showAbortButton: true, abortDisabled: false,
    isAborting: false, onAbort: noop, showSwitchButton: false, switchDisabled: false,
    isSwitching: false, onSwitch: noop, voiceEnabled: false, voiceStatus: 'disconnected',
    onVoiceToggle: noop, onSend: noop,
}

function ToolbarHarness({ onSend = noop, ...overrides }: Partial<ComposerButtonsProps>) {
    const runtime = useLocalRuntime(adapter)
    const [schedule, setSchedule] = useState<PendingSchedule | null>(null)
    const [scratchlist, setScratchlist] = useState(false)
    return <AssistantRuntimeProvider runtime={runtime}><I18nProvider>
        <ComposerButtons {...base} pendingSchedule={schedule} onSchedule={setSchedule}
            onClearSchedule={() => setSchedule(null)} scratchlistMode={scratchlist}
            onScratchlistToggle={() => setScratchlist(value => !value)}
            onSend={intent => onSend(intent)} {...overrides} />
    </I18nProvider></AssistantRuntimeProvider>
}

const fileAdapter: AttachmentAdapter = {
    accept: '*',
    async add({ file }) {
        return { id: file.name, type: 'file', name: file.name, contentType: file.type, file,
            status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async remove() {},
    async send(attachment) { return { ...attachment, status: { type: 'complete' }, content: [] } },
}

function ComposerHarness({ suggestions = vi.fn(async () => []), withAttachments = false }: { suggestions?: (query: string) => Promise<Suggestion[]>; withAttachments?: boolean }) {
    const runtime = useLocalRuntime(adapter, { adapters: withAttachments ? { attachments: fileAdapter } : {} })
    const [scratchlist, setScratchlist] = useState(false)
    return <AssistantRuntimeProvider runtime={runtime}><I18nProvider>
        <HappyComposer active agentFlavor="codex" autocompleteSuggestions={suggestions}
            scratchlistMode={scratchlist} onScratchlistToggle={() => setScratchlist(value => !value)} />
    </I18nProvider></AssistantRuntimeProvider>
}

beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('refined composer behavior', () => {
    it('inserts an actual session-reference prefix at the saved selection without replacing the draft', async () => {
        const suggestions = vi.fn(async () => [{ key: 'another', text: '@Another session', label: 'Another session', sessionMention: { id: 'another-session', title: 'Another session' } }])
        render(<ComposerHarness suggestions={suggestions} />)
        const input = screen.getByRole('textbox')
        input.textContent = 'before after'
        fireEvent.input(input)
        input.focus()
        const range = document.createRange()
        range.setStart(input.firstChild!, 7)
        range.collapse(true)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Add content' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add content' }))
        fireEvent.click(screen.getByRole('button', { name: 'Reference another session' }))
        expect(input.textContent).toBe('before @ after')
        expect(input).toHaveFocus()
        await waitFor(() => expect(suggestions).toHaveBeenCalledWith('@'))
        fireEvent.click(await screen.findByText('Another session'))
        expect(input.textContent).toBe('before @Another session after')
        expect(input.querySelector('[data-session-id="another-session"]')).not.toBeNull()
    })

    it('preserves a rich draft when entering and leaving expanded editing', async () => {
        render(<ComposerHarness />)
        const input = screen.getByRole('textbox')
        input.textContent = 'Keep this draft'
        fireEvent.input(input)
        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))
        expect(screen.getByRole('textbox').textContent).toBe('Keep this draft')
        fireEvent.click(screen.getByRole('button', { name: 'Done' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Expand message editor' })).toBeInTheDocument())
        expect(screen.getByRole('textbox').textContent).toBe('Keep this draft')
    })

    it('selects a real file from Add and retains its attachment and draft after cancelling scratchlist mode', async () => {
        render(<ComposerHarness withAttachments />)
        const input = screen.getByRole('textbox')
        input.textContent = 'Keep this question with its file'
        fireEvent.input(input)
        fireEvent.click(screen.getByRole('button', { name: 'Add content' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add images or files' }))
        const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!
        expect(picker).not.toBeNull()
        fireEvent.change(picker, { target: { files: [new File(['notes'], 'draft.txt', { type: 'text/plain' })] } })
        await waitFor(() => expect(screen.getByText('draft.txt')).toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
        expect(screen.getByRole('button', { name: 'Schedule send' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Save to scratchlist' }))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel send mode' }))
        expect(input.textContent).toBe('Keep this question with its file')
        expect(screen.getByText('draft.txt')).toBeInTheDocument()
    })

    it('uses schedule selection, scratchlist selection and cancellation without sending', () => {
        const send = vi.fn()
        render(<ToolbarHarness onSend={send} />)
        fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
        fireEvent.click(screen.getByRole('button', { name: 'Schedule send' }))
        fireEvent.click(screen.getByRole('button', { name: '+5m' }))
        expect(screen.getByRole('status')).toHaveTextContent('Scheduled send · in 5 minutes')
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save to scratchlist' }))
        expect(screen.getByRole('status')).toHaveTextContent('Saving to scratchlist')
        expect(screen.getByRole('button', { name: 'Send to scratchlist' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
        fireEvent.click(screen.getByRole('button', { name: 'Schedule send' }))
        fireEvent.click(screen.getByRole('button', { name: '+30m' }))
        expect(screen.getByRole('status')).toHaveTextContent('Scheduled send · in 30 minutes')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel send mode' }))
        expect(screen.queryByRole('status')).toBeNull()
        expect(send).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    })

    it('keeps attachment-compatible scratchlist routing and disables schedule selection', () => {
        const send = vi.fn()
        render(<ToolbarHarness hasAttachments onSend={send} />)
        fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
        expect(screen.getByRole('button', { name: 'Schedule send' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Save to scratchlist' }))
        fireEvent.click(screen.getByRole('button', { name: 'Send to scratchlist' }))
        expect(send).toHaveBeenCalledWith('default')
    })

    it('cancels the schedule picker through its direct Cancel control and Escape without sending', () => {
        const send = vi.fn()
        render(<ToolbarHarness onSend={send} />)
        const openPicker = () => {
            fireEvent.click(screen.getByRole('button', { name: 'Send options' }))
            fireEvent.click(screen.getByRole('button', { name: 'Schedule send' }))
        }
        openPicker()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('dialog', { name: 'Schedule send' })).toBeNull()
        openPicker()
        fireEvent.keyDown(screen.getByRole('dialog', { name: 'Schedule send' }), { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Schedule send' })).toBeNull()
        expect(screen.queryByRole('status')).toBeNull()
        expect(send).not.toHaveBeenCalled()
    })

    it('keeps Stop direct beside Send when a running session has a draft, including retry after failure', () => {
        const abort = vi.fn(), send = vi.fn()
        const view = render(<ToolbarHarness onAbort={abort} onSend={send} />)
        fireEvent.click(screen.getByRole('button', { name: 'Abort' }))
        view.rerender(<ToolbarHarness onAbort={abort} onSend={send} isAborting abortDisabled />)
        expect(screen.getByRole('button', { name: 'Abort' })).toBeDisabled()
        view.rerender(<ToolbarHarness onAbort={abort} onSend={send} />)
        fireEvent.click(screen.getByRole('button', { name: 'Abort' }))
        expect(abort).toHaveBeenCalledTimes(2)
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        expect(send).toHaveBeenCalledWith('default')
    })
})
