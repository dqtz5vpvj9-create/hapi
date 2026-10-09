import { DocumentRefSchema, documentKey, type DocumentResource } from './documents'
import { z } from 'zod'

export type PaneResource = DocumentResource | { kind: 'chat'; sessionId: string } | { kind: 'terminal'; sessionId: string; terminalId: string } | { kind: 'empty' }
export type PaneNode = { type: 'pane'; id: string; resource: PaneResource }
export type SplitNode = { type: 'split'; id: string; axis: 'horizontal' | 'vertical'; children: WorkspaceNode[]; weights: number[] }
export type WorkspaceNode = PaneNode | SplitNode
export type WorkspaceDocument = { id: string; name: string; root: WorkspaceNode }
export type WorkspaceSnapshot = { schemaVersion: 2; revision: number; workspaces: WorkspaceDocument[] }

const id = z.string().min(1).max(256)
export const PaneResourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('document'), sessionId: id, document: DocumentRefSchema }).strict(),
    z.object({ kind: z.literal('empty') }).strict(),
    z.object({ kind: z.literal('chat'), sessionId: id }).strict(),
    z.object({ kind: z.literal('terminal'), sessionId: id, terminalId: id }).strict(),
])
export const PaneNodeSchema = z.object({ type: z.literal('pane'), id, resource: PaneResourceSchema }).strict()
export const WorkspaceNodeSchema: z.ZodType<WorkspaceNode> = z.lazy(() => z.discriminatedUnion('type', [
    PaneNodeSchema,
    z.object({
        type: z.literal('split'), id, axis: z.enum(['horizontal', 'vertical']),
        children: z.array(WorkspaceNodeSchema).min(2), weights: z.array(z.number().positive()),
    }).strict().refine(node => node.children.length === node.weights.length, 'Each child needs a weight'),
]))
export const WorkspaceDocumentSchema = z.object({ id, name: z.string().trim().min(1).max(200), root: WorkspaceNodeSchema }).strict()

export function panes(node: WorkspaceNode): PaneNode[] {
    return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}
export function updateNode(node: WorkspaceNode, target: string, change: (node: WorkspaceNode) => WorkspaceNode): WorkspaceNode {
    if (node.id === target) return change(node)
    return node.type === 'pane' ? node : { ...node, children: node.children.map(child => updateNode(child, target, change)) }
}
export function removePane(node: WorkspaceNode, target: string): WorkspaceNode | null {
    if (node.type === 'pane') return node.id === target ? null : node
    const children: WorkspaceNode[] = [], weights: number[] = []
    node.children.forEach((child, i) => {
        const next = removePane(child, target)
        if (next) { children.push(next); weights.push(node.weights[i]) }
    })
    if (!children.length) return null
    return children.length === 1 ? children[0] : { ...node, children, weights }
}
export function sameResource(a: PaneResource, b: PaneResource): boolean {
    if (a.kind === 'empty' || b.kind === 'empty') return a.kind === b.kind
    if (a.kind === 'document' || b.kind === 'document') return a.kind === 'document' && b.kind === 'document' && documentKey(a) === documentKey(b)
    if (a.kind !== b.kind || a.sessionId !== b.sessionId) return false
    return a.kind !== 'terminal' || (b.kind === 'terminal' && a.terminalId === b.terminalId)
}
function uniqueReferences(workspaces: WorkspaceDocument[]): boolean {
    const ids = new Set<string>(), chats = new Set<string>(), terminals = new Set<string>(), documents = new Set<string>()
    function take(set: Set<string>, value: string) { if (set.has(value)) return false; set.add(value); return true }
    function visit(node: WorkspaceNode): boolean {
        if (!take(ids, node.id)) return false
        if (node.type === 'split') return node.children.every(visit)
        if (node.resource.kind === 'document') return take(documents, documentKey(node.resource))
        if (node.resource.kind === 'chat') return take(chats, node.resource.sessionId)
        if (node.resource.kind === 'terminal') return take(terminals, node.resource.terminalId)
        return true
    }
    return workspaces.every(w => take(ids, w.id) && visit(w.root))
}
export const WorkspaceSnapshotSchema = z.object({
    schemaVersion: z.literal(2), revision: z.number().int().nonnegative(), workspaces: z.array(WorkspaceDocumentSchema),
}).strict().refine(snapshot => uniqueReferences(snapshot.workspaces), 'Workspace, node and resource identities must be unique')

// Commands carry intent and stable identities. No messages, local focus, drafts or bookmarks go over this wire.
export const WorkspaceCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('import'), workspaces: z.array(WorkspaceDocumentSchema) }).strict(),
    z.object({ type: z.literal('create'), workspace: WorkspaceDocumentSchema }).strict(),
    z.object({ type: z.literal('rename'), workspaceId: id, name: z.string().trim().min(1).max(200) }).strict(),
    z.object({ type: z.literal('close'), workspaceId: id }).strict(),
    z.object({ type: z.literal('restore'), workspace: WorkspaceDocumentSchema, index: z.number().int().nonnegative(), replacementId: id }).strict(),
    z.object({ type: z.literal('bind'), paneId: id, expected: PaneResourceSchema, resource: PaneResourceSchema }).strict(),
    z.object({ type: z.literal('split'), paneId: id, splitId: id, axis: z.enum(['horizontal', 'vertical']), added: PaneNodeSchema }).strict(),
    z.object({ type: z.literal('remove'), paneId: id, replacementId: id }).strict(),
    z.object({ type: z.literal('move'), paneId: id, targetId: id, splitId: id, replacementId: id }).strict(),
    z.object({ type: z.literal('layout'), workspaceId: id, root: WorkspaceNodeSchema, basePaneIds: z.array(id), added: PaneNodeSchema.optional() }).strict(),
])
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>
export const WorkspaceOperationSchema = z.object({
    id: z.string().uuid(), command: WorkspaceCommandSchema,
}).strict()
export type WorkspaceOperation = z.infer<typeof WorkspaceOperationSchema>
export const WorkspaceUpdateRequestSchema = z.object({
    expectedRevision: z.number().int().nonnegative(), operation: WorkspaceOperationSchema,
}).strict()
export type WorkspaceUpdateRequest = z.infer<typeof WorkspaceUpdateRequestSchema>
export type WorkspaceUpdateResult = { status: 'applied' | 'duplicate' | 'conflict'; snapshot: WorkspaceSnapshot; skipped?: string }

export function applyWorkspaceCommand(workspaces: WorkspaceDocument[], command: WorkspaceCommand): { workspaces: WorkspaceDocument[]; skipped?: string } {
    const skip = (reason: string) => ({ workspaces, skipped: reason })
    const replace = (workspaceId: string, root: WorkspaceNode): WorkspaceDocument[] => workspaces.map(w => w.id === workspaceId ? { ...w, root } : w)
    const empty = (paneId: string): PaneNode => ({ type: 'pane', id: paneId, resource: { kind: 'empty' } })
    if (command.type === 'import') return workspaces.length ? skip('already-initialized') : { workspaces: command.workspaces }
    if (command.type === 'create') return workspaces.some(w => w.id === command.workspace.id) ? skip('already-exists') : { workspaces: [...workspaces, command.workspace] }
    if (command.type === 'restore') {
        if (workspaces.some(w => w.id === command.workspace.id)) return skip('already-exists')
        let root = command.workspace.root
        let next = [...workspaces]
        for (const previous of panes(root)) {
            if (previous.resource.kind === 'empty') continue
            const existing = next.flatMap(w => panes(w.root)).find(p => sameResource(p.resource, previous.resource))
            if (!existing) continue
            root = updateNode(root, previous.id, () => existing)
            next = next.map(w => ({ ...w, root: removePane(w.root, existing.id) ?? empty(`${command.replacementId}:${w.id}`) }))
        }
        next.splice(Math.min(command.index, next.length), 0, { ...command.workspace, root })
        return { workspaces: next }
    }
    if (command.type === 'rename') return { workspaces: workspaces.map(w => w.id === command.workspaceId ? { ...w, name: command.name } : w) }
    if (command.type === 'close') return { workspaces: workspaces.filter(w => w.id !== command.workspaceId) }
    if (command.type === 'layout') {
        const w = workspaces.find(w => w.id === command.workspaceId)
        if (!w) return skip('workspace-closed')
        const current = new Map(panes(w.root).map(p => [p.id, p]))
        // A late resize/reorder must not delete a concurrently added pane, resurrect a closed one,
        // or restore a previous session binding from the geometry snapshot.
        if (current.size !== command.basePaneIds.length || !command.basePaneIds.every(id => current.has(id))) return skip('layout-membership-changed')
        if (command.added) {
            const added = command.added
            if (current.has(added.id)) return skip('layout-membership-changed')
            if (added.resource.kind !== 'empty' && workspaces.flatMap(w => panes(w.root)).some(p => sameResource(p.resource, added.resource))) return skip('resource-already-open')
            current.set(added.id, added)
        }
        const next = panes(command.root)
        const nextIds = new Set(next.map(p => p.id))
        if (nextIds.size !== next.length || !next.every(p => current.has(p.id))
            || [...current.values()].some(p => !nextIds.has(p.id) && (p.resource.kind !== 'empty' || p.id === command.added?.id))) return skip('layout-membership-changed')
        function geometry(node: WorkspaceNode): WorkspaceNode {
            return node.type === 'pane' ? current.get(node.id)! : { ...node, children: node.children.map(geometry) }
        }
        return { workspaces: replace(w.id, geometry(command.root)) }
    }
    const source = workspaces.find(w => panes(w.root).some(p => p.id === command.paneId))
    if (!source) return skip('pane-closed')
    const pane = panes(source.root).find(p => p.id === command.paneId)!
    if (command.type === 'bind') {
        if (!sameResource(pane.resource, command.expected)) return skip('pane-rebound')
        if (command.resource.kind !== 'empty' && workspaces.flatMap(w => panes(w.root)).some(p => p.id !== pane.id && sameResource(p.resource, command.resource))) return skip('resource-already-open')
        return { workspaces: replace(source.id, updateNode(source.root, pane.id, () => ({ ...pane, resource: command.resource }))) }
    }
    if (command.type === 'split') {
        if (command.added.resource.kind !== 'empty' && workspaces.flatMap(w => panes(w.root)).some(p => sameResource(p.resource, command.added.resource))) return skip('resource-already-open')
        return { workspaces: replace(source.id, updateNode(source.root, pane.id, () => ({ type: 'split', id: command.splitId, axis: command.axis, children: [pane, command.added], weights: [1, 1] }))) }
    }
    if (command.type === 'remove') return { workspaces: replace(source.id, removePane(source.root, pane.id) ?? empty(command.replacementId)) }
    const target = workspaces.find(w => w.id === command.targetId)
    if (!target) return skip('workspace-closed')
    if (source === target) return skip('already-in-workspace')
    const root: WorkspaceNode = target.root.type === 'pane' && target.root.resource.kind === 'empty' ? pane
        : { type: 'split', id: command.splitId, axis: 'horizontal', children: [target.root, pane], weights: [1, 1] }
    return { workspaces: workspaces.map(w => w === source ? { ...w, root: removePane(w.root, pane.id) ?? empty(command.replacementId) } : w === target ? { ...w, root } : w) }
}
