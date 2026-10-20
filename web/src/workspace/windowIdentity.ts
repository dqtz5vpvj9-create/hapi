import { classifySessionActivity, type SessionActivityInput } from '@hapi/protocol'
import { documentName } from '@hapi/protocol/documents'
import { panes, type PaneNode, type WorkspaceDocument } from './workspaceStore'

export type WindowActivityKind = 'error' | 'permission' | 'input' | 'running' | 'background' | 'idle' | 'offline'

// Aggregate in the order a reader needs to react: the window surfaces the most
// urgent pane, so a request in a hidden pane cannot disappear from the bar.
const ACTIVITY_PRIORITY: Record<WindowActivityKind, number> = {
    error: 6, permission: 5, input: 4, running: 3, background: 2, idle: 1, offline: 0,
}

/** 1-based screen position; it matches Ctrl-b 1–9 and the number shown on the tab. */
export function windowPosition(workspaces: WorkspaceDocument[], workspaceId: string): number {
    return workspaces.findIndex(w => w.id === workspaceId) + 1
}

export function windowPane(window: WorkspaceDocument, focusedId?: string): PaneNode | undefined {
    const list = panes(window.root)
    return list.find(p => p.id === focusedId) ?? list[0]
}

/** The window's tab text: its focused pane's content, mirroring the pane header. */
export function windowPaneLabel(pane: PaneNode | undefined, title: (sessionId: string) => string, t: (key: string) => string): string {
    if (!pane || pane.resource.kind === 'empty') return t('workspace.newPane')
    if (pane.resource.kind === 'terminal') return `Terminal · ${title(pane.resource.sessionId)}`
    if (pane.resource.kind === 'document') return documentName(pane.resource.document)
    return title(pane.resource.sessionId)
}

export function windowActivityKind(sessions: (SessionActivityInput | undefined)[]): WindowActivityKind | undefined {
    let best: WindowActivityKind | undefined
    for (const session of sessions) {
        if (!session) continue
        const { kind } = classifySessionActivity(session)
        if (!best || ACTIVITY_PRIORITY[kind] > ACTIVITY_PRIORITY[best]) best = kind
    }
    return best
}

const LEGACY_AUTO_NAME = /^(?:Window|窗口)\s*\d+$/

/**
 * The name shown by "Move to" and the window switcher. Windows created without
 * an explicit name track their screen position; a hand-renamed window keeps its
 * alias. Older default names ("Window 1") follow the position too, without
 * rewriting the stored document.
 */
export function windowAlias(workspaces: WorkspaceDocument[], window: WorkspaceDocument): string {
    if (window.autoName === false) return window.name
    if (window.autoName === true || LEGACY_AUTO_NAME.test(window.name.trim())) return `W${windowPosition(workspaces, window.id)}`
    return window.name
}
