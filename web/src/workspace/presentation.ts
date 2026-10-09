/** URLs identify content. Only an explicit mode choice changes presentation. */
export function workspacePresentation(mode: 'single' | 'workspace' | undefined, pathname: string): boolean {
    return mode === 'workspace' && (pathname === '/sessions' || pathname.startsWith('/sessions/'))
}

export function workspaceChatTarget(pathname: string): string | null {
    const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname)
    if (!match || ['new', 'workspace'].includes(match[1])) return null
    try { return decodeURIComponent(match[1]) } catch { return null }
}
