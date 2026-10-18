import { act, render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { deleteCharBackward, undo, undoDepth } from '@codemirror/commands'
import { describe, expect, it, vi } from 'vitest'
import { DocumentEditor } from './DocumentEditor'
import { DocumentRegistry } from './documentSession'

function ready(text = 'base') {
    const session = new DocumentRegistry(crypto.randomUUID()).get({ kind: 'document', sessionId: 'A',
        document: { kind: 'file', path: '/project/shared.txt', machineId: 'same-machine' } })
    session.patch({ phase: 'ready', textual: true, writable: true, text, baseText: text, hash: 'original' })
    vi.spyOn(session, 'persist').mockResolvedValue(undefined)
    return session
}

function editorViews(container: HTMLElement): EditorView[] {
    return [...container.querySelectorAll<HTMLElement>('.cm-editor')].map(element => {
        const view = EditorView.findFromDOM(element)
        if (!view) throw new Error('Expected a mounted CodeMirror editor')
        return view
    })
}

function append(view: EditorView, text: string) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length }, userEvent: 'input.type' })
}

function saveShortcut(view: EditorView) {
    return runScopeHandlers(view, new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true }), 'editor')
}

describe('DocumentEditor shared document binding', () => {
    it('synchronously shares both panes\' input without echoing edits or selections', () => {
        const session = ready()
        const edit = vi.spyOn(session, 'edit')
        const patch = vi.spyOn(session, 'patch')
        const { container } = render(<><DocumentEditor session={session} onSave={() => {}} findRevision={0} />
            <DocumentEditor session={session} onSave={() => {}} findRevision={0} /></>)
        const [first, second] = editorViews(container)

        act(() => append(first, ' from A'))
        expect(second.state.doc.toString()).toBe('base from A')
        expect(edit).toHaveBeenCalledTimes(1)
        expect(patch.mock.calls.filter(([value]) => 'selection' in value)).toHaveLength(1)

        act(() => append(second, ' and B'))
        expect(session.state.text).toBe('base from A and B')
        expect(first.state.doc.toString()).toBe(session.state.text)
        expect(second.state.doc.toString()).toBe(session.state.text)
        expect(edit).toHaveBeenCalledTimes(2)
        expect(patch.mock.calls.filter(([value]) => 'selection' in value)).toHaveLength(2)
    })

    it('maps a sibling selection around the minimal edit and preserves its scroll position', () => {
        const session = ready('prefix target suffix')
        const { container } = render(<><DocumentEditor session={session} onSave={() => {}} findRevision={0} />
            <DocumentEditor session={session} onSave={() => {}} findRevision={0} /></>)
        const [first, second] = editorViews(container)
        act(() => second.dispatch({ selection: { anchor: 7, head: 13 } }))
        second.scrollDOM.scrollTop = 73

        act(() => first.dispatch({ changes: { from: 0, insert: 'New ' }, selection: { anchor: 4 } }))
        expect(second.state.selection.main).toMatchObject({ from: 11, to: 17 })
        expect(second.state.sliceDoc(11, 17)).toBe('target')
        expect(second.scrollDOM.scrollTop).toBe(73)
        expect(session.state.selection).toBeUndefined()
    })

    it('keeps each pane\'s undo local while mapping it over the other pane\'s changes', () => {
        const session = ready()
        const { container } = render(<><DocumentEditor session={session} onSave={() => {}} findRevision={0} />
            <DocumentEditor session={session} onSave={() => {}} findRevision={0} /></>)
        const [first, second] = editorViews(container)
        act(() => append(first, ' A'))
        expect(undoDepth(first.state)).toBe(1)
        expect(undoDepth(second.state)).toBe(0)
        act(() => append(second, ' B'))
        expect(first.state.doc.toString()).toBe('base A B')
        expect(undoDepth(first.state)).toBe(1)
        expect(undoDepth(second.state)).toBe(1)

        act(() => expect(undo(first)).toBe(true))
        expect(session.state.text).toBe('base B')
        expect(second.state.doc.toString()).toBe('base B')
        act(() => expect(undo(second)).toBe(true))
        expect(session.state.text).toBe('base')
        expect(first.state.doc.toString()).toBe('base')
    })

    it('routes retained keymaps to the current mount and latest save callback', () => {
        const session = ready()
        const initialSave = vi.fn(), nextPaneSave = vi.fn(), updatedSave = vi.fn()
        const initial = render(<DocumentEditor session={session} onSave={initialSave} findRevision={0} />)
        act(() => append(editorViews(initial.container)[0], ' retained'))
        initial.unmount()
        expect(session.editorState).toBeDefined()

        const next = render(<DocumentEditor session={session} onSave={nextPaneSave} findRevision={0} />)
        const view = editorViews(next.container)[0]
        expect(undoDepth(view.state)).toBe(1)
        act(() => expect(saveShortcut(view)).toBe(true))
        expect(nextPaneSave).toHaveBeenCalledTimes(1)
        expect(initialSave).not.toHaveBeenCalled()

        next.rerender(<DocumentEditor session={session} onSave={updatedSave} findRevision={0} />)
        expect(editorViews(next.container)[0]).toBe(view)
        act(() => expect(saveShortcut(view)).toBe(true))
        expect(updatedSave).toHaveBeenCalledTimes(1)
        expect(nextPaneSave).toHaveBeenCalledTimes(1)
        act(() => append(view, ' new input'))
        expect(session.state.text).toBe('base retained new input')
    })

    it('updates readonly state without recreating the view or losing local undo', () => {
        const session = ready()
        const edit = vi.spyOn(session, 'edit')
        const { container } = render(<DocumentEditor session={session} onSave={() => {}} findRevision={0} />)
        const view = editorViews(container)[0]
        act(() => append(view, ' draft'))
        act(() => session.patch({ writable: false }))
        expect(editorViews(container)[0]).toBe(view)
        expect(view.state.facet(EditorState.readOnly)).toBe(true)
        expect(view.contentDOM).toHaveAttribute('contenteditable', 'false')
        expect(undoDepth(view.state)).toBe(1)
        act(() => expect(deleteCharBackward(view)).toBe(false))
        expect(session.state.text).toBe('base draft')
        expect(edit).toHaveBeenCalledTimes(1)

        act(() => session.patch({ writable: true }))
        expect(view.state.facet(EditorState.readOnly)).toBe(false)
        expect(view.contentDOM).toHaveAttribute('contenteditable', 'true')
        expect(undoDepth(view.state)).toBe(1)
        act(() => expect(undo(view)).toBe(true))
        expect(session.state.text).toBe('base')
    })

    it('reconfigures a retained editor after permissions change while it is unmounted', () => {
        const session = ready()
        const initial = render(<DocumentEditor session={session} onSave={() => {}} findRevision={0} />)
        act(() => append(editorViews(initial.container)[0], ' draft'))
        initial.unmount()
        session.patch({ writable: false })

        const next = render(<DocumentEditor session={session} onSave={() => {}} findRevision={0} />)
        const view = editorViews(next.container)[0]
        expect(view.state.facet(EditorState.readOnly)).toBe(true)
        expect(view.contentDOM).toHaveAttribute('contenteditable', 'false')
        expect(undoDepth(view.state)).toBe(1)
    })

    it('does not retain an idle sibling over the latest editing pane or keep its subscription after unmount', () => {
        const session = ready()
        const first = render(<DocumentEditor session={session} onSave={() => {}} findRevision={0} />)
        const sibling = render(<DocumentEditor session={session} onSave={() => {}} findRevision={0} />)
        const editingView = editorViews(first.container)[0], idleView = editorViews(sibling.container)[0]
        editingView.scrollDOM.scrollTop = 44
        idleView.scrollDOM.scrollTop = 12
        act(() => append(editingView, ' local undo'))
        const retained = session.editorState
        const dispatch = vi.spyOn(idleView, 'dispatch')
        sibling.unmount()
        expect(session.editorState).toBe(retained)
        expect(session.scrollTop).not.toBe(12)
        act(() => append(editingView, ' still active'))
        expect(dispatch).not.toHaveBeenCalled()
        expect(session.state.text).toBe('base local undo still active')
        first.unmount()
        expect(session.scrollTop).toBe(44)
    })
})
