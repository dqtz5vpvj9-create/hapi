import type { SessionSummary } from '@/types/api'
import {
    directNativeChildRows,
    nativeSubagentRows,
    type NativeSubagentRow,
} from '@/components/SubagentChat/nativeSubagents'
import type { SessionHierarchy } from './sessionHierarchy'

type RowBase = { id: string; depth: number; root: SessionSummary; expanded: boolean; childCount: number }
export type SessionTreeRow = RowBase & (
    | { kind: 'session'; session: SessionSummary }
    | { kind: 'native'; session: SessionSummary; agent: NativeSubagentRow; agents: NativeSubagentRow[] }
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

/** Codex children indexed by parent thread; DSH rows are direct children. */
type NativeCatalog = {
    rows: NativeSubagentRow[]
    codexByParent: Map<string, NativeSubagentRow[]>
}

function createCatalog(session: SessionSummary): NativeCatalog {
    const rows = nativeSubagentRows(session.metadata)
    const codexByParent = new Map<string, NativeSubagentRow[]>()
    for (const row of rows) {
        if (row.flavor !== 'codex' || !row.parentId) continue
        const children = codexByParent.get(row.parentId) ?? []
        children.push(row)
        codexByParent.set(row.parentId, children)
    }
    return { rows, codexByParent }
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
        | { kind: 'native'; session: SessionSummary; agent: NativeSubagentRow; agents: NativeSubagentRow[]; root: SessionSummary; depth: number }
    const pending: Pending[] = roots.map(session => ({ kind: 'session' as const, session, root: session, depth: 0 })).reverse()
    const visitedNativeRows = new Set<string>()
    const catalogs = new Map<SessionSummary, NativeCatalog>()
    const catalogOf = (session: SessionSummary) => {
        let catalog = catalogs.get(session)
        if (!catalog) {
            catalog = createCatalog(session)
            catalogs.set(session, catalog)
        }
        return catalog
    }
    while (pending.length) {
        const item = pending.pop()!
        if (item.kind === 'session') {
            const { session, root, depth } = item
            const open = revealChildren || (expanded.get(session.id) ?? selectedAncestors.has(session.id))
                || (tree.pendingDescendants.get(session.id) ?? 0) > 0
            const children = tree.children.get(session.id) ?? []
            const catalog = catalogOf(session)
            const hapiChildAgentIds = new Set(children
                .map(child => child.metadata?.agentSessionId)
                .filter((id): id is string => Boolean(id)))
            const natives = directNativeChildRows(catalog.rows, session.metadata?.agentSessionId, hapiChildAgentIds)
            rows.push({ kind: 'session', id: session.id, session, root, depth, expanded: open, childCount: children.length + natives.length })
            if (!open) continue
            for (let index = natives.length - 1; index >= 0; index--) {
                pending.push({ kind: 'native', session, agent: natives[index], agents: catalog.rows, root, depth: depth + 1 })
            }
            for (let index = children.length - 1; index >= 0; index--) {
                pending.push({ kind: 'session', session: children[index], root, depth: depth + 1 })
            }
        } else {
            const { session, agent, agents, root, depth } = item
            const id = `native:${session.id}:${agent.id}`
            if (visitedNativeRows.has(id)) continue
            visitedNativeRows.add(id)
            const open = revealChildren || Boolean(expanded.get(id))
            const children = catalogOf(session).codexByParent.get(agent.id) ?? []
            rows.push({ kind: 'native', id, session, agent, agents, root, depth, expanded: open, childCount: children.length })
            if (!open) continue
            for (let index = children.length - 1; index >= 0; index--) {
                pending.push({ kind: 'native', session, agent: children[index], agents, root, depth: depth + 1 })
            }
        }
    }
    return rows
}
