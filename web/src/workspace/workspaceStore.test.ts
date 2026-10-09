import { beforeEach, describe, expect, it } from 'vitest'
import { Actions, DockLocation } from 'flexlayout-react'
import { panes, WorkspaceStore } from './workspaceStore'
import { workspaceModel, workspaceTree } from './layoutAdapter'

beforeEach(() => localStorage.clear())

describe('workspace tasks', () => {
    it('keeps existing chats unique, restores split sizes on reload and returns from single view', () => {
        const store = new WorkspaceStore('test')
        store.enter('A')
        const a = store.focusedPane()!.id
        expect(store.openSession('B', 'horizontal')).toBe(true)
        const b = store.focusedPane()!.id
        const model = workspaceModel(store.active()!, id => id)
        model.doAction(Actions.adjustWeights(model.getRootRow()!.getId(), [30, 70]))
        store.setRoot(store.active()!.id, workspaceTree(model, store.active()!)!)
        store.create('Other')
        expect(store.openSession('A', 'vertical')).toBe(false)
        expect(store.focusedPane()!.id).toBe(a)
        expect(store.get().workspaces.flatMap(w => panes(w.root)).filter(p => p.resource.kind === 'chat')).toHaveLength(2)
        store.focus(b)
        expect(store.leave()).toBe('B')
        const restored = new WorkspaceStore('test')
        restored.enter()
        expect(restored.get().mode).toBe('workspace')
        expect(restored.focusedPane()!.id).toBe(b)
        expect(restored.active()!.root).toMatchObject({ type: 'split', weights: [30, 70] })
    })

    it('saves the reader before structural changes and ignores late results from replaced panes', () => {
        const store = new WorkspaceStore('test')
        store.enter('A')
        const id = store.focusedPane()!.id
        const observations: string[] = []
        store.callbacks(id).add(() => { const resource = store.focusedPane()!.resource; if (resource.kind === 'chat') observations.push(resource.sessionId) })
        store.openSession('B')
        store.bind(id, { kind: 'chat', sessionId: 'resumed-A' }, 'A')
        expect(observations[0]).toBe('A')
        expect(store.focusedPane()!.resource).toEqual({ kind: 'chat', sessionId: 'B' })
    })

    it('moves one resource atomically, closes views, and restores a closed workspace', () => {
        const store = new WorkspaceStore('test')
        store.enter('A')
        const a = store.focusedPane()!, first = store.active()!.id
        store.terminal('A')
        const terminal = store.focusedPane()!
        store.create('Second')
        const second = store.active()!.id
        store.movePane(a.id, second)
        expect(panes(store.get().workspaces.find(w => w.id === first)!.root)).toEqual([terminal])
        expect(panes(store.active()!.root)).toEqual([a])
        store.closeWorkspace(first)
        store.undoClose()
        expect(panes(store.active()!.root)).toEqual([terminal])
        // No terminate/delete-session API is involved in any view operation.
        store.closePane(terminal.id)
        expect(store.focusedPane()!.resource).toEqual({ kind: 'empty' })
    })

    it('returns to the last chat from a terminal and does not duplicate a resumed or reopened conversation', () => {
        const store = new WorkspaceStore('test')
        store.enter('A')
        const original = store.active()!.id
        store.terminal('A')
        expect(store.leave()).toBe('A')
        store.enter()
        store.openSession('B')
        const b = store.focusedPane()!.id
        store.bind(b, { kind: 'chat', sessionId: 'A' }, 'B')
        expect(store.get().workspaces.flatMap(w => panes(w.root)).filter(p => p.resource.kind === 'chat')).toHaveLength(1)
        store.closeWorkspace(original)
        store.create('Reopened')
        store.openSession('A')
        const reopened = store.focusedPane()!.id
        store.undoClose()
        expect(store.active()!.id).toBe(original)
        expect(store.focusedPane()!.id).toBe(reopened)
        expect(store.get().workspaces.flatMap(w => panes(w.root)).filter(p => p.resource.kind === 'chat')).toHaveLength(1)
    })

    it('round trips nested splits, edge moves and resizing without changing resource identity', () => {
        const store = new WorkspaceStore('test')
        store.enter('A'); store.openSession('B', 'horizontal'); store.openSession('C', 'vertical')
        const workspace = store.active()!, original = panes(workspace.root)
        const model = workspaceModel(workspace, id => id)
        const b = original.find(p => p.resource.kind === 'chat' && p.resource.sessionId === 'B')!
        const c = original.find(p => p.resource.kind === 'chat' && p.resource.sessionId === 'C')!
        model.doAction(Actions.moveNode(c.id, model.getNodeById(b.id)!.getParent()!.getId(), DockLocation.LEFT, -1))
        const root = workspaceTree(model, workspace)!
        const roundTrip = workspaceModel({ ...workspace, root }, id => id, model)
        expect(panes(root).map(p => p.id).sort()).toEqual(original.map(p => p.id).sort())
        expect(workspaceTree(roundTrip, { ...workspace, root })).toEqual(root)
    })
})
