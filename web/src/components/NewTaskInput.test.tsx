import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NewTaskInput } from './NewTaskInput'
import { getDraft } from '@/lib/composer-drafts'
import { loadNewTaskDraft, saveNewTaskDraft, stageNewTaskDraft } from '@/lib/new-task-draft'

afterEach(cleanup)
beforeEach(() => sessionStorage.clear())
function mount(hub: string, onContinue = vi.fn()) {
    return { onContinue, ...render(<I18nProvider><NewTaskInput hub={hub} onContinue={onContinue} /></I18nProvider>) }
}
describe('New task entry handoff', () => {
    it('keeps task text across backing out and stages it only after creation', () => {
        const { unmount, onContinue } = mount('hub-a')
        fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Review the mobile layout' } })
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        expect(onContinue).toHaveBeenCalledOnce()
        expect(loadNewTaskDraft('hub-a')).toBe('Review the mobile layout')
        expect(getDraft('fresh-entry-session')).toBe('')
        unmount()
        mount('hub-a')
        expect(screen.getByRole('textbox')).toHaveValue('Review the mobile layout')
        act(() => stageNewTaskDraft('hub-a', 'fresh-entry-session', loadNewTaskDraft('hub-a')))
        expect(getDraft('fresh-entry-session')).toBe('Review the mobile layout')
        expect(loadNewTaskDraft('hub-a')).toBe('')
    })
    it('keeps task drafts separate for different hubs and opens options without sending', () => {
        const first = mount('hub-a')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Task on first hub' } })
        first.unmount()
        const second = mount('hub-b')
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Task on second hub' } })
        fireEvent.click(screen.getByRole('button', { name: 'New session options' }))
        expect(second.onContinue).toHaveBeenCalledOnce()
        expect(loadNewTaskDraft('hub-a')).toBe('Task on first hub')
        expect(loadNewTaskDraft('hub-b')).toBe('Task on second hub')
    })
    it('updates a mounted hidden list entry after config edits and clears it after successful creation', () => {
        const { onContinue } = mount('hub-mounted')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original task' } })
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        // Config-page edits affect the same store while the sidebar stays mounted.
        act(() => saveNewTaskDraft('hub-mounted', 'Updated on configuration page'))
        expect(screen.getByRole('textbox')).toHaveValue('Updated on configuration page')
        fireEvent.click(screen.getByRole('button', { name: 'New session options' }))
        expect(loadNewTaskDraft('hub-mounted')).toBe('Updated on configuration page')
        expect(onContinue).toHaveBeenCalledTimes(2)
        act(() => stageNewTaskDraft('hub-mounted', 'new-session-after-config', loadNewTaskDraft('hub-mounted')))
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        expect(loadNewTaskDraft('hub-mounted')).toBe('')
        expect(getDraft('new-session-after-config')).toBe('Updated on configuration page')
    })

})
