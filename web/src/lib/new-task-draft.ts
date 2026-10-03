import { saveDraft } from './composer-drafts'

const listeners = new Map<string, Set<() => void>>()
const unavailableStorageDrafts = new Map<string, string>()

function key(hub: string | null | undefined): string {
    return `hapi:new-task:${hub || window.location.origin}`
}

export function loadNewTaskDraft(hub?: string | null): string {
    try { return sessionStorage.getItem(key(hub)) ?? '' }
    catch { return unavailableStorageDrafts.get(key(hub)) ?? '' }
}

export function saveNewTaskDraft(hub: string | null | undefined, text: string): void {
    try {
        if (text) sessionStorage.setItem(key(hub), text)
        else sessionStorage.removeItem(key(hub))
    } catch { unavailableStorageDrafts.set(key(hub), text) }
    listeners.get(key(hub))?.forEach(listener => listener())
}

export function subscribeNewTaskDraft(hub: string | null | undefined, listener: () => void): () => void {
    const scope = key(hub)
    let scopeListeners = listeners.get(scope)
    if (!scopeListeners) { scopeListeners = new Set(); listeners.set(scope, scopeListeners) }
    scopeListeners.add(listener)
    return () => { scopeListeners.delete(listener); if (scopeListeners.size === 0) listeners.delete(scope) }
}

/** Stage text only after a new session has been created; never send it. */
export function stageNewTaskDraft(hub: string | null | undefined, sessionId: string, text: string): void {
    if (text.trim()) saveDraft(sessionId, text)
    saveNewTaskDraft(hub, '')
}
