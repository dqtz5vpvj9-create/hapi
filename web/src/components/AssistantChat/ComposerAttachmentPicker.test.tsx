import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AssistantRuntimeProvider, useAui, useAuiState, useLocalRuntime,
    type AttachmentAdapter, type ChatModelAdapter,
} from '@assistant-ui/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { AppContextProvider } from '@/lib/app-context'
import type { ApiClient } from '@/api/client'
import { NativeAttachmentButton } from '@/components/NativeAttachmentButton'
import { ComposerAttachmentPicker } from './ComposerAttachmentPicker'
import { ComposerButtons, type ComposerButtonsProps } from './ComposerButtons'

const mocks = vi.hoisted(() => ({ native: true, pick: vi.fn(), glass: false }))
vi.mock('@/lib/platform', () => ({ isNativePlatform: () => mocks.native }))
vi.mock('@/lib/nativeAttachments', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/nativeAttachments')>(),
    pickNativeAttachments: mocks.pick,
}))
vi.mock('@/themes/glass/GlassScene', async importOriginal => ({
    ...await importOriginal<typeof import('@/themes/glass/GlassScene')>(),
    useGlassLayout: () => mocks.glass,
}))

const adapter: ChatModelAdapter = { async *run() {} }
const fileAdapter: AttachmentAdapter = {
    accept: '*',
    async add({ file }) {
        return { id: crypto.randomUUID(), type: 'file', name: file.name, contentType: file.type, file,
            status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async remove() {},
    async send(attachment) { return { ...attachment, status: { type: 'complete' }, content: [] } },
}

const noop = () => {}
const toolbarProps: ComposerButtonsProps = {
    canSend: true, controlsDisabled: false, showSettingsButton: false, onSettingsToggle: noop,
    expanded: false, onExpandedToggle: noop, showTerminalButton: false, terminalDisabled: false,
    terminalLabel: 'Terminal', onTerminal: noop, showAbortButton: false, abortDisabled: false,
    isAborting: false, onAbort: noop, showSwitchButton: false, switchDisabled: false,
    isSwitching: false, onSwitch: noop, voiceEnabled: false, voiceStatus: 'disconnected',
    onVoiceToggle: noop, onSend: noop,
}

let aui: ReturnType<typeof useAui>
let currentRuntime: ReturnType<typeof useLocalRuntime>

function Capture({ disabled, toolbar }: { disabled?: boolean; toolbar?: boolean }) {
    aui = useAui()
    const composer = useAuiState(state => state.composer)
    return <>
        <p data-testid="draft">{composer.text}</p>
        <ul aria-label="Selected files">{composer.attachments.map(item => <li key={item.id}>{item.name}</li>)}</ul>
        {toolbar ? <ComposerButtons {...toolbarProps} controlsDisabled={disabled ?? false} />
            : <ComposerAttachmentPicker disabled={disabled}>Attach files</ComposerAttachmentPicker>}
    </>
}

function Harness({ disabled, toolbar, children }: { disabled?: boolean; toolbar?: boolean; children?: ReactNode }) {
    const runtime = useLocalRuntime(adapter, { adapters: { attachments: fileAdapter } })
    currentRuntime = runtime
    return <AssistantRuntimeProvider runtime={runtime}><I18nProvider>
        {children ?? <Capture disabled={disabled} toolbar={toolbar} />}
    </I18nProvider></AssistantRuntimeProvider>
}

function openSource(source = 'Photos') {
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    fireEvent.click(screen.getByRole('button', { name: source }))
}

beforeEach(() => {
    localStorage.clear()
    mocks.native = true
    mocks.glass = false
    mocks.pick.mockReset().mockResolvedValue([])
})
afterEach(() => {
    cleanup()
    document.querySelectorAll('input[type="file"]').forEach(input => input.remove())
    vi.restoreAllMocks()
})

describe('native composer attachment selection', () => {
    it('adds native files to the actual composer while retaining its text and existing attachments', async () => {
        const photo = new File(['image'], '原图.HEIC', { type: 'image/heic' })
        const notes = new File(['notes'], 'notes.txt', { type: 'text/plain' })
        mocks.pick.mockResolvedValue([photo, notes])
        render(<Harness />)
        await act(async () => {
            aui.composer().setText('Existing draft')
            await aui.composer().addAttachment(new File(['old'], 'existing.txt'))
        })
        openSource()
        await waitFor(() => expect(aui.composer().getState().attachments).toHaveLength(3))
        expect(aui.composer().getState().attachments.map(item => item.name)).toEqual(['existing.txt', '原图.HEIC', 'notes.txt'])
        expect(aui.composer().getState().attachments[1].file).toBe(photo)
        expect(screen.getByTestId('draft')).toHaveTextContent('Existing draft')
        expect(mocks.pick).toHaveBeenCalledWith('photos', expect.any(AbortSignal))
        expect(document.querySelector('input[type="file"]')).toBeNull()
    })

    it('keeps the browser input path and does not invoke the native picker in Web mode', async () => {
        mocks.native = false
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
        render(<Harness />)
        fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
        expect(input).not.toBeNull()
        expect(input.multiple).toBe(true)
        fireEvent.change(input, { target: { files: [new File(['web'], 'browser.txt')] } })
        await waitFor(() => expect(screen.getByText('browser.txt')).toBeInTheDocument())
        expect(mocks.pick).not.toHaveBeenCalled()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('treats cancel as a no-op that preserves the existing draft', async () => {
        render(<Harness />)
        await act(async () => { await aui.composer().addAttachment(new File(['old'], 'existing.txt')) })
        openSource('Files')
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(aui.composer().getState().attachments.map(item => item.name)).toEqual(['existing.txt'])
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows genuine provider errors and allows another selection without clearing attachments', async () => {
        mocks.pick.mockRejectedValueOnce({ message: 'Cloud provider permission denied' })
        render(<Harness />)
        await act(async () => { await aui.composer().addAttachment(new File(['old'], 'existing.txt')) })
        openSource('Files')
        expect(await screen.findByRole('alert')).toHaveTextContent('Cloud provider permission denied')
        expect(screen.getByText('existing.txt')).toBeInTheDocument()
        mocks.pick.mockResolvedValueOnce([new File(['retry'], 'retried.txt')])
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))
        await waitFor(() => expect(screen.getByText('retried.txt')).toBeInTheDocument())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('disables repeated taps until the first picker finishes', async () => {
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        render(<Harness />)
        openSource()
        fireEvent.click(screen.getByRole('button', { name: 'Photos' }))
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))
        expect(mocks.pick).toHaveBeenCalledOnce()
        await act(async () => finish([new File(['photo'], 'one.jpg')]))
        await waitFor(() => expect(aui.composer().getState().attachments).toHaveLength(1))
    })

    it('retains picker ownership after the single-chat Add menu closes', async () => {
        mocks.glass = true
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        render(<Harness toolbar />)
        fireEvent.click(screen.getByRole('button', { name: 'Add content' }))
        fireEvent.click(screen.getByRole('button', { name: 'Add images or files' }))
        fireEvent.click(screen.getByRole('button', { name: 'Photos' }))
        await act(async () => finish([new File(['image'], 'from-menu.jpg')]))
        await waitFor(() => expect(screen.getByText('from-menu.jpg')).toBeInTheDocument())
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('does not add late native results to a replacement conversation', async () => {
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        render(<Harness />)
        await act(async () => { await currentRuntime.threads.mainItem.initialize() })
        const original = aui.threads.getState().mainThreadId
        openSource()
        await act(async () => { aui.threads.switchToNewThread() })
        await waitFor(() => expect(aui.threads.getState().mainThreadId).not.toBe(original))
        await act(async () => finish([new File(['private'], 'old-session.txt')]))
        expect(aui.composer().getState().attachments).toHaveLength(0)
        expect(mocks.pick.mock.calls[0][1].aborted).toBe(true)
    })

    it('discards a selection after attachments become disabled', async () => {
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const view = render(<Harness />)
        openSource()
        view.rerender(<Harness disabled />)
        await act(async () => finish([new File(['late'], 'late.txt')]))
        expect(aui.composer().getState().attachments).toHaveLength(0)
    })
})

describe('native picker draft and hub ownership', () => {
    it('aborts pending reads after unmounting', async () => {
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const add = vi.fn()
        const view = render(<I18nProvider><NativeAttachmentButton onFiles={add}>Attach files</NativeAttachmentButton></I18nProvider>)
        openSource()
        view.unmount()
        expect(mocks.pick.mock.calls[0][1].aborted).toBe(true)
        await act(async () => finish([new File(['late'], 'late.txt')]))
        expect(add).not.toHaveBeenCalled()
    })

    it('rejects a late selection when the retained draft connects to another hub', async () => {
        let finish!: (files: File[]) => void
        mocks.pick.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const add = vi.fn()
        const apiA = {} as ApiClient
        const apiB = {} as ApiClient
        const component = (api: ApiClient, baseUrl: string) => <AppContextProvider value={{ api, baseUrl, token: 'test' }}>
            <I18nProvider><NativeAttachmentButton selectionScope="same-draft" onFiles={add}>Attach files</NativeAttachmentButton></I18nProvider>
        </AppContextProvider>
        const view = render(component(apiA, 'https://hub-a.example'))
        openSource('Files')
        view.rerender(component(apiB, 'https://hub-b.example'))
        await act(async () => finish([new File(['private'], 'hub-a.txt')]))
        expect(add).not.toHaveBeenCalled()
        expect(mocks.pick.mock.calls[0][1].aborted).toBe(true)
        expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled()
    })
})
