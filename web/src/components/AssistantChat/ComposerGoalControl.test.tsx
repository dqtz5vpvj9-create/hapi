import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ThreadGoal } from '@/types/api'
import { ComposerGoalControl } from './ComposerGoalControl'

const goal: ThreadGoal = { threadId: 'thread', objective: 'Keep the app useful', status: 'paused', tokensUsed: 10, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
const setup = (onAction = vi.fn().mockResolvedValue(goal), current: ThreadGoal | null = goal) => {
    render(<I18nProvider><ComposerGoalControl goal={current} disabled={false} onAction={onAction} /></I18nProvider>)
    return onAction
}
const openEditor = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Goal controls' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit current goal' }))
}

describe('Goal controls', () => {
    beforeEach(() => localStorage.clear())
    it('opens a goal-only menu and edits a multiline goal without staging a chat command', async () => {
        const action = setup()
        openEditor()
        expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument()
        const editor = screen.getByRole('textbox', { name: 'Goal' })
        expect(editor).toHaveValue(goal.objective)
        expect(editor).toHaveFocus()
        fireEvent.change(editor, { target: { value: 'Improve scrolling\nKeep the draft safe' } })
        fireEvent.keyDown(editor, { key: 'Enter' })
        expect(action).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(action).toHaveBeenCalledWith({ action: 'set', objective: 'Improve scrolling\nKeep the draft safe' })
    })
    it('keeps edited content after a failed save and allows retry', async () => {
        const action = setup(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(goal))
        openEditor()
        const editor = screen.getByRole('textbox', { name: 'Goal' })
        fireEvent.change(editor, { target: { value: 'clear' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
        await screen.findByRole('alert')
        expect(editor).toHaveValue('clear')
        expect(screen.getByRole('button', { name: 'Save goal' })).toBeEnabled()
        fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(action).toHaveBeenLastCalledWith({ action: 'set', objective: 'clear' })
    })
    it('cancels editing without saving and returns focus to Goal', async () => {
        const action = setup()
        openEditor()
        fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), { target: { value: 'Discard this edit' } })
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(action).not.toHaveBeenCalled()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Goal controls' })).toHaveFocus())
        openEditor()
        expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue(goal.objective)
    })
    it('prevents empty and oversized goals, creates a goal when none exists', () => {
        setup(undefined, null)
        fireEvent.click(screen.getByRole('button', { name: 'Goal controls' }))
        fireEvent.click(screen.getByRole('button', { name: 'Set a goal' }))
        const save = screen.getByRole('button', { name: 'Save goal' })
        expect(save).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), { target: { value: 'x'.repeat(4001) } })
        expect(save).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), { target: { value: 'Valid goal' } })
        expect(save).toBeEnabled()
    })
    it('shows pending state, prevents double saves and blocks closing while saving', async () => {
        let finish!: (goal: ThreadGoal) => void
        const action = setup(vi.fn(() => new Promise<ThreadGoal>(resolve => { finish = resolve })))
        openEditor()
        fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
        expect(screen.getByRole('button', { name: 'Saving goal…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Goal' }), { key: 'Enter', ctrlKey: true })
        expect(action).toHaveBeenCalledTimes(1)
        finish(goal)
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })
    it('applies pause/resume immediately and confirms clearing', async () => {
        const action = setup(vi.fn().mockResolvedValueOnce({ ...goal, status: 'active' }).mockResolvedValue(null))
        fireEvent.click(screen.getByRole('button', { name: 'Goal controls' }))
        fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
        await screen.findByRole('button', { name: 'Pause goal' })
        expect(action).toHaveBeenCalledWith({ action: 'resume' })
        fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
        expect(action).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(action).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
        fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
        await screen.findByRole('button', { name: 'Set a goal' })
        expect(action).toHaveBeenLastCalledWith({ action: 'clear' })
    })
})
