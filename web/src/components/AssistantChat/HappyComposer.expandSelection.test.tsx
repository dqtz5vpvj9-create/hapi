import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HappyComposer } from './HappyComposer'

vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        expanded: boolean
        onExpandedToggle: () => void
        showSettingsButton: boolean
        settingsButtonRef?: Ref<HTMLButtonElement>
        onSettingsToggle: () => void
    }) => (
        <div>
            <button
                type="button"
                aria-label={props.expanded ? 'Collapse message editor' : 'Expand message editor'}
                onClick={props.onExpandedToggle}
            />
            {props.showSettingsButton ? (
                <button
                    ref={props.settingsButtonRef}
                    type="button"
                    aria-label="Composer settings"
                    onClick={props.onSettingsToggle}
                />
            ) : null}
        </div>
    ),
}))

vi.mock('@/components/AssistantChat/StatusBar', () => ({
    StatusBar: (props: { composerControl?: ReactNode }) => props.composerControl ?? null,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: {
            impact: () => {},
            notification: () => {},
            selection: () => {},
        },
    }),
}))
vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({
        installState: 'idle',
        canInstall: false,
        canInstallIOS: false,
        isStandalone: false,
        isIOS: false,
        promptInstall: async () => false,
        dismissInstall: () => {},
    }),
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.typeAMessage' ? 'Type a message' : key,
    }),
}))

const adapter: ChatModelAdapter = {
    async *run() {},
}

function TestRuntime(props: { withSettings?: boolean; withGoal?: boolean }) {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyComposer
                agentFlavor={props.withGoal ? 'codex' : props.withSettings ? 'claude' : undefined}
                active={props.withGoal ? true : undefined}
                onGoalAction={props.withGoal ? async () => null : undefined}
                onPermissionModeChange={props.withSettings ? () => {} : undefined}
            />
            {props.withSettings ? (
                <button
                    type="button"
                    aria-label="Outside action"
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : null}
        </AssistantRuntimeProvider>
    )
}

describe('HappyComposer plain-text expansion', () => {
    afterEach(() => vi.unstubAllGlobals())

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        localStorage.clear()
        localStorage.setItem('hapi.composer.richMentions', '0')
    })

    it('preserves draft text and selection across expand and collapse', async () => {
        render(<TestRuntime />)

        const draft = 'A long draft with a selection in the middle that must survive both editor layout changes.'
        const collapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        fireEvent.change(collapsedInput, { target: { value: draft } })
        collapsedInput.setSelectionRange(12, 36, 'forward')

        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Collapse message editor' })).toBeInTheDocument()
            const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(expandedInput).not.toBe(collapsedInput)
            expect(expandedInput.value).toBe(draft)
            expect(expandedInput.selectionStart).toBe(12)
            expect(expandedInput.selectionEnd).toBe(36)
            expect(expandedInput.selectionDirection).toBe('forward')
            expect(document.activeElement).toBe(expandedInput)
        })

        const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        expandedInput.setSelectionRange(42, 67, 'backward')
        fireEvent.click(screen.getByRole('button', { name: 'Collapse message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Expand message editor' })).toBeInTheDocument()
            const nextCollapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(nextCollapsedInput).not.toBe(expandedInput)
            expect(nextCollapsedInput.value).toBe(draft)
            expect(nextCollapsedInput.selectionStart).toBe(42)
            expect(nextCollapsedInput.selectionEnd).toBe(67)
            expect(nextCollapsedInput.selectionDirection).toBe('backward')
            expect(document.activeElement).toBe(nextCollapsedInput)
        })
    })

    it('Escape closes settings first, then collapses the expanded editor with its draft intact', async () => {
        render(<TestRuntime withSettings />)
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this edited question' } })
        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse message editor' })).toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Composer settings' }))
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Collapse message editor' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Composer settings' })).toHaveFocus()
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Expand message editor' })).toBeInTheDocument())
        expect(screen.getByRole('textbox')).toHaveValue('Keep this edited question')
    })

    it('closes settings when clicking outside while preserving inside and trigger interactions', () => {
        render(<TestRuntime withSettings />)

        const settingsButton = screen.getByRole('button', { name: 'Composer settings' })
        fireEvent.click(settingsButton)

        const panelLabel = screen.getByText('misc.permissionMode')
        fireEvent.pointerDown(panelLabel)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('textbox'))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside action' }))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()
    })

    it.each(['plain', 'rich'])('preserves the %s draft and selection after cancelling Goal editing twice', async mode => {
        localStorage.setItem('hapi.composer.richMentions', mode === 'rich' ? '1' : '0')
        render(<TestRuntime withGoal />)
        const input = screen.getByRole('textbox')
        const draft = 'LOCAL_GOAL_CANCEL_DRAFT'
        if (mode === 'rich') {
            input.textContent = draft
            fireEvent.input(input)
        } else {
            fireEvent.change(input, { target: { value: draft } })
        }
        input.focus()
        if (mode === 'rich') {
            const text = input.firstChild!
            window.getSelection()?.setBaseAndExtent(text, 8, text, 2)
        } else {
            (input as HTMLTextAreaElement).setSelectionRange(2, 8, 'backward')
        }

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const trigger = screen.getByRole('button', { name: 'composer.goal.control' })
            fireEvent.pointerDown(trigger)
            fireEvent.click(trigger)
            fireEvent.click(screen.getByRole('button', { name: 'composer.goal.create' }))
            const goalEditor = screen.getByRole('textbox', { name: 'composer.goal.objective' })
            expect(goalEditor).toHaveFocus()
            // A focused textarea replaces the browser's contenteditable selection.
            // jsdom does not implement that browser behavior, so model it here.
            window.getSelection()?.removeAllRanges()
            fireEvent.change(goalEditor, { target: { value: 'Discard this goal edit' } })
            fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))

            await waitFor(() => {
                expect(screen.queryByRole('dialog', { name: 'composer.goal.create' })).not.toBeInTheDocument()
                expect(input).toHaveFocus()
                if (mode === 'rich') {
                    expect(input.textContent).toBe(draft)
                    expect(window.getSelection()?.toString()).toBe('CAL_GO')
                    expect(window.getSelection()?.anchorOffset).toBe(8)
                    expect(window.getSelection()?.focusOffset).toBe(2)
                } else {
                    const textarea = input as HTMLTextAreaElement
                    expect(textarea.value).toBe(draft)
                    expect(textarea.selectionStart).toBe(2)
                    expect(textarea.selectionEnd).toBe(8)
                    expect(textarea.selectionDirection).toBe('backward')
                }
            })
        }
    })
})
