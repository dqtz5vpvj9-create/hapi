import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { buildSessionHierarchy } from './sessionHierarchy'
import { projectSessionTreeRows } from './sessionTreeRows'
function session(id: string, parent?: string): SessionSummary {
    return { id, active: false, thinking: false, activeAt: 0, updatedAt: 100,
        metadata: { name: id, path: '/tree', flavor: 'codex', machineId: 'm', agentSessionId: id, codexParentThreadId: parent },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null }
}
function project(items: SessionSummary[], expanded = new Map<string, boolean>(), reveal = false, selected?: string) {
    const tree = buildSessionHierarchy(items, items)
    return projectSessionTreeRows(tree.roots, tree, expanded, reveal, selected)
}
describe('Recent tree row projection', () => {
    it.each([100, 1000])('projects one wide root only when expanded (%i children)', count => {
        const items = [session('root'), ...Array.from({ length: count }, (_, index) => session(`child-${index}`, 'root'))]
        expect(project(items).map(row => row.id)).toEqual(['root'])
        const rows = project(items, new Map([['root', true]]))
        expect(rows).toHaveLength(count + 1)
        expect(rows[0].childCount).toBe(count)
        expect(rows.slice(1).every(row => row.depth === 1 && row.root.id === 'root')).toBe(true)
    })
    it('keeps filtered ancestors without admitting nonmatching siblings', () => {
        const items = [session('root'), session('branch', 'root'), session('leaf', 'branch'), session('sibling', 'root')]
        const tree = buildSessionHierarchy([items[2]], items)
        expect(projectSessionTreeRows(tree.roots, tree, new Map(), true).map(row => row.id)).toEqual(['root', 'branch', 'leaf'])
    })
    it('seeds selection and pending chains while honoring an explicit selected-ancestor collapse', () => {
        const items = [session('root'), session('branch', 'root'), session('leaf', 'branch')]
        expect(project(items, new Map(), false, 'leaf').map(row => row.id)).toEqual(['root', 'branch', 'leaf'])
        expect(project(items, new Map([['root', false]]), false, 'leaf').map(row => row.id)).toEqual(['root'])
        items[2].pendingRequestsCount = 1
        expect(project(items).map(row => row.id)).toEqual(['root', 'branch', 'leaf'])
    })
    it('merges direct native/HAPI children once and preserves the actual metadata owner', () => {
        const root = session('root'), child = session('hapi-child', 'root')
        root.metadata!.codexSubagents = [
            { threadId: 'hapi-child', parentThreadId: 'root', status: 'unknown' },
            { threadId: 'native-child', parentThreadId: 'root', status: 'unknown' },
            { threadId: 'native-grandchild', parentThreadId: 'native-child', status: 'unknown' },
        ]
        child.metadata!.codexSubagents = [{ threadId: 'owned-grandchild', parentThreadId: 'hapi-child', status: 'unknown' }]
        const rows = project([root, child], new Map(), true)
        expect(rows.map(row => row.id)).toEqual(['root', 'hapi-child', 'native:hapi-child:owned-grandchild', 'native:root:native-child', 'native:root:native-grandchild'])
        expect(rows.map(row => row.depth)).toEqual([0, 1, 2, 1, 2])
        expect(rows[0].childCount).toBe(2)
    })
    it('does not recurse or repeatedly scan native ancestry for a deep chain', () => {
        const root = session('root')
        root.metadata!.codexSubagents = Array.from({ length: 10000 }, (_, i) => ({ threadId: `native-${i}`, parentThreadId: i ? `native-${i - 1}` : 'root', status: 'unknown' as const }))
        const rows = project([root], new Map(), true)
        expect(rows).toHaveLength(10001)
        expect(rows.at(-1)?.depth).toBe(10000)
    })
    it('retains root dates on all descendants across different days', () => {
        const a = session('a'), child = session('child', 'a'), b = session('b')
        a.updatedAt = 200; child.updatedAt = 500; b.updatedAt = 100
        expect(project([a, child, b], new Map(), true).map(row => row.root.updatedAt)).toEqual([200, 200, 100])
    })
})
