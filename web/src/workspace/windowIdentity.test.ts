import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionActivityInput } from '@hapi/protocol'
import type { NativeRuntimeState } from '@hapi/protocol/schemas'
import { nextWindowName, panes, WorkspaceStore } from './workspaceStore'
import { windowActivityKind, windowAlias, windowPane, windowPaneLabel, windowPosition } from './windowIdentity'

const t = (key: string) => key
const title = (id: string) => `title:${id}`

function session(status: NativeRuntimeState['status'], overrides: Partial<NativeRuntimeState> = {}): SessionActivityInput {
    return {
        active: true,
        thinking: false,
        pendingRequestKinds: [],
        backgroundTaskCount: 0,
        execution: { status, waitingOn: [], owner: 'm', generation: 'g', sequence: 1, turnId: null, startedAt: null, completedAt: null, ...overrides },
    }
}

beforeEach(() => localStorage.clear())

describe('window naming', () => {
    it('derives W1…Wn for new windows and reuses a freed number', () => {
        const store = new WorkspaceStore('window-names')
        store.enter('A')
        const first = store.get().workspaces[0]
        expect(first).toMatchObject({ name: 'W1', autoName: true })
        store.create()
        const second = store.get().workspaces[1]
        expect(second).toMatchObject({ name: 'W2', autoName: true })
        store.closeWorkspace(second.id)
        expect(nextWindowName(store.get().workspaces)).toBe('W2')
        store.create()
        expect(store.get().workspaces[1].name).toBe('W2')
        expect(panes(store.get().workspaces[1].root)).toHaveLength(1)
    })

    it('keeps an explicit name as a manual alias and lets rename pin it', () => {
        const store = new WorkspaceStore('window-alias')
        store.enter('A')
        store.create('Research')
        const manual = store.get().workspaces[1]
        expect(windowAlias(store.get().workspaces, manual)).toBe('Research')
        store.rename(manual.id, ' Review ')
        const renamed = store.get().workspaces[1]
        expect(renamed).toMatchObject({ name: 'Review', autoName: false })
        expect(windowAlias(store.get().workspaces, renamed)).toBe('Review')
    })

    it('follows the position for automatic and legacy default names', () => {
        const store = new WorkspaceStore('window-position')
        store.enter('A')
        store.create()
        const workspaces = store.get().workspaces
        expect(windowAlias(workspaces, workspaces[1])).toBe('W2')
        expect(windowPosition(workspaces, workspaces[1].id)).toBe(2)
        // Older documents predate the flag but still carry the old default text.
        const legacy = { ...workspaces[1], name: 'Window 2', autoName: undefined }
        expect(windowAlias(workspaces, legacy)).toBe('W2')
        const custom = { ...workspaces[1], name: '发布检查', autoName: undefined }
        expect(windowAlias(workspaces, custom)).toBe('发布检查')
    })
})

describe('window labels', () => {
    it('uses the focused pane of each window, not the active window', () => {
        const store = new WorkspaceStore('window-labels')
        store.enter('A')
        const first = store.active()!
        store.openSession('B', 'horizontal')
        const workspace = store.active()!
        expect(windowPaneLabel(windowPane(workspace, store.get().focused[workspace.id]), title, t)).toBe('title:B')

        const firstPane = panes(first.root)[0]
        store.focus(firstPane.id)
        expect(windowPaneLabel(windowPane(workspace, store.get().focused[workspace.id]), title, t)).toBe('title:A')
        expect(windowPaneLabel(windowPane(workspace, undefined), title, t)).toBe('title:A')
    })

    it('falls back for empty, terminal and document panes', () => {
        const empty = { type: 'pane' as const, id: 'e', resource: { kind: 'empty' as const } }
        expect(windowPaneLabel(empty, title, t)).toBe('workspace.newPane')
        const terminal = { type: 'pane' as const, id: 't', resource: { kind: 'terminal' as const, sessionId: 'A', terminalId: 'x' } }
        expect(windowPaneLabel(terminal, title, t)).toBe('Terminal · title:A')
        const document = { type: 'pane' as const, id: 'd', resource: { kind: 'document' as const, sessionId: 'A', document: { kind: 'file' as const, path: '/tmp/plan.md', machineId: 'm' } } }
        expect(windowPaneLabel(document, title, t)).toBe('plan.md')
    })
})

describe('window activity', () => {
    it('surfaces the most urgent chat pane in the window', () => {
        expect(windowActivityKind([session('idle'), session('active')])).toBe('running')
        expect(windowActivityKind([session('active'), session('active', { waitingOn: ['approval'] })])).toBe('permission')
        expect(windowActivityKind([session('active', { waitingOn: ['input'] }), session('systemError')])).toBe('error')
        expect(windowActivityKind([session('idle'), undefined])).toBe('idle')
        expect(windowActivityKind([undefined])).toBeUndefined()
    })
})
