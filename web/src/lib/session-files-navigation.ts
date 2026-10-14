/** A file-manager target is always relative to its session, never a URI. */
export function normalizeFileManagerTarget(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value || value.length > 8192
        || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')
        || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined
    const parts = value.split('/')
    if (parts.includes('..')) return undefined
    const target = parts.filter(part => part && part !== '.').join('/')
    return target || undefined
}

/** Convert an explicit Markdown path without widening the session boundary. */
export function fileManagerTargetFromPath(path: string, workspacePath: string | null | undefined): string | undefined {
    if (!workspacePath || !path || /[\u0000-\u001f\u007f]/.test(path)) return undefined
    const windows = /^[A-Za-z]:[\\/]/.test(workspacePath)
    const absoluteWindows = /^[A-Za-z]:[\\/]/.test(path)
    if (absoluteWindows && !windows) return undefined
    if (path.startsWith('//') || path.startsWith('\\\\')) return undefined
    const value = windows ? path.replaceAll('\\', '/') : path
    const root = (windows ? workspacePath.replaceAll('\\', '/') : workspacePath).replace(/\/+$/, '')
    if (value.startsWith('/') || absoluteWindows) {
        const prefix = `${root}/`
        const within = windows ? value.toLowerCase().startsWith(prefix.toLowerCase()) : value.startsWith(prefix)
        if (!within) return undefined
        return normalizeFileManagerTarget(value.slice(prefix.length))
    }
    return normalizeFileManagerTarget(value)
}

export type SessionFilesSearch = { tab?: 'changes' | 'directories'; query?: string; target?: string }

export function parseSessionFilesSearch(search: Record<string, unknown>): SessionFilesSearch {
    const tab = search.tab === 'directories' || search.tab === 'changes' ? search.tab : undefined
    const query = typeof search.query === 'string' && search.query ? search.query : undefined
    const target = normalizeFileManagerTarget(search.target)
    return { ...(tab ? { tab } : {}), ...(query ? { query } : {}), ...(target ? { target } : {}) }
}
