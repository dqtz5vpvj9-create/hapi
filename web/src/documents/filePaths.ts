import type { DocumentResource } from '@hapi/protocol/documents'

function parts(path: string, windows: boolean): string {
    const value = windows ? path.replaceAll('\\', '/') : path
    const prefix = value.startsWith('//') && windows ? '//' : value.startsWith('/') ? '/' : ''
    const result: string[] = []
    for (const part of value.slice(prefix.length).split('/')) {
        if (!part || part === '.') continue
        if (part === '..' && result.length && result.at(-1) !== '..') result.pop()
        else result.push(part)
    }
    return prefix + result.join('/')
}

/** A path-component match, using the remote machine's path dialect. */
export function filePathSuffix(path: string, parent: string): string | null {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parent)
    const source = parts(path, windows), root = parts(parent, windows).replace(/\/$/, '')
    const key = windows ? source.toLowerCase() : source
    const prefix = windows ? root.toLowerCase() : root
    if (key === prefix) return ''
    return key.startsWith(prefix + '/') ? source.slice(root.length) : null
}

export function relocatedFilePath(path: string, from: string, to: string): string | null {
    const suffix = filePathSuffix(path, from)
    if (suffix === null) return null
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(to)
    return parts(to, windows).replace(/\/$/, '') + suffix
}

export function sameFileMachine(resource: DocumentResource, owner: { sessionId: string; machineId?: string }): boolean {
    return resource.document.kind === 'file' && (owner.machineId
        ? resource.document.machineId === owner.machineId
        : resource.sessionId === owner.sessionId && !resource.document.machineId)
}
