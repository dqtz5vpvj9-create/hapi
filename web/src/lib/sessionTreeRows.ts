import type { SessionSummary } from '@/types/api'
import type { SessionHierarchy } from './sessionHierarchy'

type NativeSubagent = NonNullable<NonNullable<SessionSummary['metadata']>['codexSubagents']>[number]
type RowBase = { id: string; depth: number; root: SessionSummary; expanded: boolean; childCount: number }
export type SessionTreeRow = RowBase & (
    | { kind: 'session'; session: SessionSummary }
    | { kind: 'native'; session: SessionSummary; agent: NativeSubagent; agents: NativeSubagent[] }
)

export function selectedSessionAncestors(tree: SessionHierarchy, selectedId?: string | null): Set<string> {
    const ancestors = new Set<string>()
    let id = selectedId ? tree.parent.get(selectedId) : undefined
    while (id && !ancestors.has(id)) {
        ancestors.add(id)
        id = tree.parent.get(id)
    }
    return ancestors
}

/** Project only on content/expansion changes, never on a virtual scroll update.
 * Expansion/search can cost O(n); mounted rows still follow the viewport window.
 * An explicit stack also avoids overflowing on deeply nested imported sessions. */
export function projectSessionTreeRows(
    roots: readonly SessionSummary[],
    tree: SessionHierarchy,
    expanded: ReadonlyMap<string, boolean>,
    revealChildren: boolean,
    selectedId?: string | null,
): SessionTreeRow[] {
    const selectedAncestors = selectedSessionAncestors(tree, selectedId)
    const rows: SessionTreeRow[] = []
    type Pending = { kind: 'session'; session: SessionSummary; root: SessionSummary; depth: number }
        | { kind: 'native'; session: SessionSummary; agent: NativeSubagent; agents: NativeSubagent[]; root: SessionSummary; depth: number }
    const pending: Pending[] = roots.map(session => ({ kind: 'session' as const, session, root: session, depth: 0 })).reverse()
    const visitedNativeRows = new Set<string>()
    const nativeIndexes = new Map<NativeSubagent[], Map<string, NativeSubagent[]>>()
    const nativeChildren = (agents: NativeSubagent[], parentId: string | undefined) => {
        let index = nativeIndexes.get(agents)
        if (!index) {
            index = new Map()
            for (const agent of agents) {
                const key = agent.parentThreadId ?? ''
                const children = index.get(key) ?? []
                children.push(agent)
                index.set(key, children)
            }
            nativeIndexes.set(agents, index)
        }
        return index.get(parentId ?? '') ?? []
    }
    while (pending.length) {
        const item = pending.pop()!
        if (item.kind === 'session') {
            const { session, root, depth } = item
            const open = revealChildren || (expanded.get(session.id) ?? selectedAncestors.has(session.id))
                || (tree.pendingDescendants.get(session.id) ?? 0) > 0
            const children = tree.children.get(session.id) ?? []
            const agents = session.metadata?.codexSubagents ?? []
            const childThreads = new Set(children.map(child => child.metadata?.agentSessionId))
            const natives = agents.length === 0 ? [] : nativeChildren(agents, session.metadata?.agentSessionId).filter(agent => !childThreads.has(agent.threadId))
            rows.push({ kind: 'session', id: session.id, session, root, depth, expanded: open, childCount: children.length + natives.length })
            if (!open) continue
            for (let index = natives.length - 1; index >= 0; index--) {
                pending.push({ kind: 'native', session, agent: natives[index], agents, root, depth: depth + 1 })
            }
            for (let index = children.length - 1; index >= 0; index--) {
                pending.push({ kind: 'session', session: children[index], root, depth: depth + 1 })
            }
        } else {
            const { session, agent, agents, root, depth } = item
            const id = `native:${session.id}:${agent.threadId}`
            if (visitedNativeRows.has(id)) continue
            visitedNativeRows.add(id)
            const open = revealChildren || Boolean(expanded.get(id))
            const children = nativeChildren(agents, agent.threadId)
            rows.push({ kind: 'native', id, session, agent, agents, root, depth, expanded: open, childCount: children.length })
            if (!open) continue
            for (let index = children.length - 1; index >= 0; index--) {
                pending.push({ kind: 'native', session, agent: children[index], agents, root, depth: depth + 1 })
            }
        }
    }
    return rows
}
