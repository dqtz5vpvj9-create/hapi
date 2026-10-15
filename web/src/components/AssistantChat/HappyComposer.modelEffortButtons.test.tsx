import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { HappyComposer } from './HappyComposer'

/**
 * Focused harness for unified model/effort controls and independent permissions. Reuses the assistant-ui mock strategy from
 * HappyComposer.sendError.test.tsx but keeps ComposerButtons unmocked so the
 * picker portal is exercised for real.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    pendingSendIntentRef: { current: 'default' },
    sentIntents: [] as ComposerSendIntent[],
    narrowViewport: false,
    toolbarLayout: null as ComposerToolbarLayout | null,
    cancelRun: vi.fn(),
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent as ComposerSendIntent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: runtime.cancelRun }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            AddAttachment: ({ children }: { children: ReactNode }) => <>{children}</>,
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                ({
                    asChild: _asChild,
                    onChange,
                    maxRows: _maxRows,
                    submitOnEnter: _submitOnEnter,
                    cancelOnEscape: _cancelOnEscape,
                    ...props
                }, ref) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                        }}
                    />
                ),
            ),
        },
    }
})
vi.mock('@/hooks/useComposerToolbarLayout', async () => {
    const actual = await import('@/hooks/useComposerToolbarLayout')
    return {
        ...actual,
        useComposerToolbarLayout: () => ({ layout: runtime.toolbarLayout ?? actual.DEFAULT_COMPOSER_TOOLBAR_LAYOUT }),
    }
})
vi.mock('@/hooks/useNarrowViewport', () => ({
    useNarrowViewport: () => runtime.narrowViewport,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))

function renderComposer(agentFlavor: string, overrides: Partial<Parameters<typeof HappyComposer>[0]> = {}) {
    render(
        <I18nProvider>
            <HappyComposer
                sessionId="composer-test"
                disabled={false}
                agentFlavor={agentFlavor}
                model="claude-sonnet-4"
                effort="high"
                permissionMode="default"
                onModelChange={vi.fn()}
                onEffortChange={vi.fn()}
                onPermissionModeChange={vi.fn()}
                availableModelOptions={[{ value: 'claude-sonnet-4', label: 'Sonnet 4' }]}
                pendingSendIntentRef={runtime.pendingSendIntentRef as { current: ComposerSendIntent }}
                {...overrides}
            />
        </I18nProvider>
    )
}

const piModels = [
    { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
    { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
]
const piSelectedModel = { provider: 'gemini', modelId: 'gemini-2.5-pro' }
function openPicker(name = 'Sonnet 4 · High') {
    const trigger = screen.getByRole('button', { name })
    fireEvent.click(trigger)
    return trigger
}

describe('HappyComposer unified model/effort picker', () => {
    beforeEach(() => {
        localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
        runtime.cancelRun.mockClear()
    })
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.narrowViewport = false
        runtime.toolbarLayout = null
        runtime.snapshot.thread.isDisabled = false
        runtime.sentIntents = []
        runtime.snapshot.thread.isRunning = false
        localStorage.removeItem('hapi.fue.v1.rich-composer-mentions')
    })

    it.each([false, true])('exposes exact Codex reasoning capabilities, narrow=%s', narrow => {
        runtime.narrowViewport = narrow
        const change = vi.fn()
        renderComposer('codex', { modelReasoningEffort: 'medium', onModelReasoningEffortChange: change,
            availableModelReasoningEffortOptions: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] })
        openPicker('Sonnet 4 · Medium')
        expect(screen.getByRole('slider')).toHaveAttribute('max', '3')
        expect(screen.queryByText('Permission Mode')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Max' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'High' }))
        expect(change).toHaveBeenCalledWith('high')
    })

    it('changes permission independently through Yolo status', () => {
        const change = vi.fn()
        renderComposer('codex', { permissionMode: 'yolo', onPermissionModeChange: change })
        fireEvent.click(screen.getByRole('button', { name: 'Permission Mode: Yolo' }))
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        expect(screen.queryByRole('slider')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Default' }))
        expect(change).toHaveBeenCalledWith('default')
        expect(screen.queryByText('Permission Mode')).toBeNull()
    })

    it('returns focus to the capsule on Escape without aborting', async () => {
        renderComposer('claude')
        const trigger = openPicker()
        fireEvent.keyDown(screen.getByRole('slider'), { key: 'Escape' })
        expect(screen.queryByRole('slider')).toBeNull()
        await waitFor(() => expect(trigger).toHaveFocus())
        expect(runtime.cancelRun).not.toHaveBeenCalled()
    })

    it.each([false, true])('uses one capsule with no duplicate controls, narrow=%s', narrow => {
        runtime.narrowViewport = narrow
        renderComposer('claude')
        expect(screen.getByRole('button', { name: 'Sonnet 4 · High' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    })

    it('omits effort controls when unsupported', () => {
        renderComposer('codex', { effort: null })
        openPicker('Sonnet 4')
        expect(screen.queryByRole('slider')).toBeNull()
    })

    it('opens effort first, then checked models, then returns to effort', () => {
        const change = vi.fn()
        renderComposer('claude', { onModelChange: change, availableModelOptions: [
            { value: 'claude-sonnet-4', label: 'Sonnet 4' }, { value: 'claude-opus-4', label: 'Opus 4' },
        ] })
        openPicker()
        expect(screen.getByRole('slider')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Opus 4' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4' }))
        expect(screen.getByRole('button', { name: 'Sonnet 4' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Opus 4' }))
        expect(change).toHaveBeenCalledWith('claude-opus-4')
        expect(screen.getByRole('slider')).toBeTruthy()
    })

    it('qualifies Pi selection by provider when model IDs collide', () => {
        const change = vi.fn()
        renderComposer('pi', { piModels, piSelectedModel: { ...piSelectedModel, provider: 'vertex' }, onModelChange: change })
        openPicker('Vertex Gemini 2.5 Pro · High')
        fireEvent.click(screen.getByRole('button', { name: 'Vertex Gemini 2.5 Pro' }))
        expect(screen.getByRole('button', { name: 'Vertex Gemini 2.5 Pro' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: 'Gemini 2.5 Pro' })).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro' }))
        expect(change).toHaveBeenCalledWith(piSelectedModel)
    })

    it('keeps the capsule reachable on mobile despite hidden settings layout', () => {
        runtime.narrowViewport = true
        runtime.toolbarLayout = { mode: 'left', left: ['attachment', 'expand', 'terminal'], right: [], hidden: ['settings', 'abort'] }
        renderComposer('claude')
        openPicker()
        expect(screen.getByRole('slider')).toBeTruthy()
    })

    it.each(['running', 'disabled', 'thinking'] as const)('prevents Pi mutation during %s turns', state => {
        runtime.narrowViewport = true
        runtime.snapshot.thread.isRunning = state === 'running'
        runtime.snapshot.thread.isDisabled = state === 'disabled'
        const change = vi.fn()
        renderComposer('pi', { piModels, piSelectedModel, thinking: state === 'thinking', onEffortChange: change })
        const trigger = screen.getByRole('button', { name: 'Gemini 2.5 Pro · High' })
        expect(trigger).toBeDisabled()
        fireEvent.click(trigger)
        expect(screen.queryByRole('slider')).toBeNull()
        expect(change).not.toHaveBeenCalled()
    })

    it('exposes no unqualified Pi fallback with an unresolved catalog', () => {
        renderComposer('pi', { model: 'gemini-2.5-pro', piModels: [], piSelectedModel: null })
        expect(screen.queryByRole('button', { name: /gemini-2.5-pro/ })).toBeNull()
        expect(screen.queryByRole('slider')).toBeNull()
    })

    it('uses explicit Default instead of toggling selected Pi effort off', () => {
        const change = vi.fn()
        renderComposer('pi', { piModels, piSelectedModel, onEffortChange: change })
        openPicker('Gemini 2.5 Pro · High')
        fireEvent.click(screen.getByRole('button', { name: 'High' }))
        expect(change).toHaveBeenLastCalledWith('high')
        fireEvent.click(screen.getByRole('button', { name: 'Default' }))
        expect(change).toHaveBeenLastCalledWith(null)
    })

    it('requires explicit choice for incompatible Pi effort', () => {
        const change = vi.fn()
        renderComposer('pi', { effort: 'max', piModels, piSelectedModel, onEffortChange: change })
        expect(change).not.toHaveBeenCalled()
        openPicker('Gemini 2.5 Pro · max')
        expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Choose a supported')
        expect(screen.queryByRole('button', { name: 'Max' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'High' }))
        expect(change).toHaveBeenCalledWith('high')
    })

    it('filters Pi effort stops using provider capabilities', () => {
        renderComposer('pi', { piModels: [{ ...piModels[0], thinkingLevelMap: { low: null, medium: null, xhigh: 'high', max: null } }], piSelectedModel })
        openPicker('Gemini 2.5 Pro · High')
        expect(screen.queryByRole('button', { name: 'Low' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Medium' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Max' })).toBeNull()
        expect(screen.getByRole('button', { name: 'XHigh' })).toBeTruthy()
    })

    it('offers only Default for non-reasoning Pi models', () => {
        renderComposer('pi', { effort: null, piModels: [{ ...piModels[0], reasoning: false }], piSelectedModel })
        openPicker('Gemini 2.5 Pro · Default')
        expect(screen.getByRole('slider')).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Default' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    })

    it.each([null, 'auto', 'default'])('labels default model %s consistently', model => {
        renderComposer('claude', { model })
        expect(screen.getByRole('button', { name: 'Default · High' })).toBeTruthy()
    })

    it('keeps Fast independent from effort', () => {
        const effortChange = vi.fn()
        const fastChange = vi.fn()
        renderComposer('claude', { onEffortChange: effortChange, onServiceTierChange: fastChange, serviceTier: 'standard' })
        openPicker()
        fireEvent.click(screen.getByRole('switch', { name: 'Fast' }))
        expect(fastChange).toHaveBeenCalledWith('fast')
        expect(effortChange).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Low' }))
        expect(effortChange).toHaveBeenCalledWith('low')
        expect(fastChange).toHaveBeenCalledTimes(1)
    })

    it('disables already-open controls when the session becomes inactive', () => {
        const change = vi.fn()
        const common = {
            sessionId: 'composer-test', disabled: false, agentFlavor: 'pi',
            model: 'gemini-2.5-pro', effort: 'high', piModels, piSelectedModel,
            onModelChange: vi.fn(), onEffortChange: change,
        }
        const { rerender } = render(<I18nProvider><HappyComposer {...common} active /></I18nProvider>)
        openPicker('Gemini 2.5 Pro · High')
        expect(screen.getByRole('button', { name: 'High' })).not.toBeDisabled()
        rerender(<I18nProvider><HappyComposer {...common} active={false} /></I18nProvider>)
        const high = screen.queryByRole('button', { name: 'High' })
        // Closing a now-disabled picker or disabling its open rows both prevent mutation.
        if (high) {
            expect(high).toBeDisabled()
            fireEvent.click(high)
        }
        expect(change).not.toHaveBeenCalled()
    })

    it('leaves a different modal its Escape while permission settings are open', () => {
        renderComposer('codex', { permissionMode: 'yolo' })
        fireEvent.click(screen.getByRole('button', { name: 'Permission Mode: Yolo' }))
        const modal = document.createElement('div')
        modal.setAttribute('role', 'dialog')
        modal.setAttribute('aria-modal', 'true')
        document.body.appendChild(modal)
        fireEvent.keyDown(modal, { key: 'Escape' })
        expect(screen.getByText('Permission Mode')).toBeTruthy()
        modal.remove()
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
        expect(screen.queryByText('Permission Mode')).toBeNull()
    })

    it('selects Cursor variants through the unified effort page', () => {
        const change = vi.fn()
        renderComposer('cursor', {
            model: 'composer-2.5-fast', selectedModelBase: 'composer-2.5', selectedModelVariant: 'composer-2.5-fast',
            onModelEffortChange: change,
            availableModelOptions: [{ value: 'composer-2.5', label: 'Composer 2.5' }],
            modelEffortOptions: [{ value: 'composer-2.5-fast', label: 'Fast' }, { value: 'composer-2.5-mini', label: 'Mini' }],
        })
        openPicker('Composer 2.5 · Fast')
        expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Mini' }))
        expect(change).toHaveBeenCalledWith('composer-2.5-mini')
    })
})
