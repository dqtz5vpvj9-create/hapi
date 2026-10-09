import { documentName, type SelectionReference } from '@hapi/protocol/documents'

const subscribers = new Map<string, Set<() => void>>()
const scopes = new Set<string>()
const key = (scope: string, session: string) => `${scope}:document-references:${session}`
export function selectionReferenceText(reference: SelectionReference): string {
    const { resource, selection, version } = reference
    const location = selection.kind === 'text' ? `lines ${selection.lineStart}–${selection.lineEnd}${selection.precision === 'block' ? ' (source block)' : `; UTF-16 offsets ${selection.from}–${selection.to} in LF-normalized source`}`
        : selection.kind === 'cells' ? `${selection.sheet}!${selection.range}`
        : selection.kind === 'html' ? `rendered HTML; DOM range ${JSON.stringify({ start: selection.start, end: selection.end })}`
        : `page ${selection.page}${selection.rect ? `; normalized region ${JSON.stringify(selection.rect)}` : ''}`
    const path = resource.document.kind === 'file' ? resource.document.path : `artifact:${resource.document.artifactId}`
    return `[${documentName(resource.document)} · ${location}]\nSource: ${path}\nRevision: ${version || 'unavailable'}\n${selection.quote ? selection.quote.split('\n').map(line => `> ${line}`).join('\n') : ''}`
}
export function pendingSelections(scope: string, session: string): SelectionReference[] {
    scopes.add(scope)
    try {
        const value: unknown = JSON.parse(localStorage.getItem(key(scope, session)) ?? '[]')
        return Array.isArray(value) ? value as SelectionReference[] : []
    } catch { return [] }
}
export function attachSelection(scope: string, reference: SelectionReference) {
    const pending = pendingSelections(scope, reference.targetSessionId)
    if (pending.some(item => item.id === reference.id)) return
    localStorage.setItem(key(scope, reference.targetSessionId), JSON.stringify([...pending, reference]))
    subscribers.get(key(scope, reference.targetSessionId))?.forEach(fn => fn())
}
export function acknowledgeSelections(scope: string, session: string, ids: string[]) {
    const rest = pendingSelections(scope, session).filter(item => !ids.includes(item.id))
    if (rest.length) localStorage.setItem(key(scope, session), JSON.stringify(rest))
    else localStorage.removeItem(key(scope, session))
    subscribers.get(key(scope, session))?.forEach(fn => fn())
}
export function subscribeSelections(scope: string, session: string, fn: () => void) {
    const id = key(scope, session), list = subscribers.get(id) ?? new Set()
    scopes.add(scope); subscribers.set(id, list); list.add(fn)
    const changed = (event: StorageEvent) => { if (event.key === id) fn() }
    window.addEventListener('storage', changed)
    return () => { list.delete(fn); if (!list.size) subscribers.delete(id); window.removeEventListener('storage', changed) }
}
export function moveSelectionDrafts(source: string, target: string) {
    for (const scope of scopes) {
        const pending = pendingSelections(scope, source)
        for (const reference of pending) attachSelection(scope, { ...reference, targetSessionId: target })
        if (pending.length) localStorage.removeItem(key(scope, source))
        subscribers.get(key(scope, source))?.forEach(fn => fn())
    }
}
