import { normalizeFileManagerTarget } from '@/lib/session-files-navigation'

export function fileManagerBasename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
}

export function fileManagerParent(path: string): string {
    const separator = path.lastIndexOf('/')
    return separator < 0 ? '' : path.slice(0, separator)
}

export function fileManagerJoin(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name
}

/** Reject ambiguous names instead of silently changing the operation's target. */
export function validFileManagerName(value: string): boolean {
    return value.length > 0 && value.trim().length > 0 && value !== '.' && value !== '..'
        && !/[\\/\u0000-\u001f\u007f]/.test(value) && !/^[A-Za-z]:/.test(value)
}

export function fileManagerDestination(value: string): string | undefined {
    if (value.includes('\\')) return undefined
    return normalizeFileManagerTarget(value)
}

export function fileManagerContains(parent: string, path: string, caseInsensitive = false): boolean {
    const left = caseInsensitive ? parent.toLowerCase() : parent
    const right = caseInsensitive ? path.toLowerCase() : path
    return left === right || right.startsWith(`${left}/`)
}

/** A selected directory already includes its selected descendants in a batch. */
export function topLevelFileManagerPaths(paths: readonly string[], caseInsensitive = false): string[] {
    const ordered = [...new Set(paths)].filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b))
    return ordered.filter((path, index) => !ordered.slice(0, index).some(parent => fileManagerContains(parent, path, caseInsensitive)))
}

/** Hidden ancestors count too, so tree and search filtering agree. */
export function isHiddenFileManagerPath(path: string): boolean {
    return path.split('/').some(part => part.startsWith('.') && part !== '.' && part !== '..')
}

/** Deliberately a small glob subset: *, ** and ?; all other characters are literal. */
export function matchesFileManagerExclude(path: string, patterns: readonly string[]): boolean {
    return patterns.some(raw => {
        const pattern = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
        if (!pattern || pattern.length > 256) return false
        let source = ''
        for (let index = 0; index < pattern.length; index++) {
            const char = pattern[index]
            if (char === '*' && pattern[index + 1] === '*') {
                if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2 }
                else { source += '.*'; index += 1 }
            } else if (char === '*') source += '[^/]*'
            else if (char === '?') source += '[^/]'
            else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }
        // A bare name/pattern applies at any depth. Matched directories include their subtree.
        const prefix = pattern.includes('/') ? '^' : '(?:^|/)'
        return new RegExp(`${prefix}${source}(?:/|$)`).test(path)
    })
}

export type FileManagerUploadItem = { file: File; relativePath: string }

export function fileManagerUploadItems(files: readonly File[]): FileManagerUploadItem[] {
    return files.map(file => {
        const path = file.webkitRelativePath || file.name
        const relativePath = fileManagerDestination(path)
        // A folder picker supplies a relative hierarchy, never a path on the remote machine.
        if (!relativePath || path.startsWith('/') || path.split('/').some(part => !validFileManagerName(part))) {
            throw new Error(`Invalid upload path: ${path}`)
        }
        return { file, relativePath }
    })
}

export function fileManagerUploadParents(path: string): string[] {
    const parts = path.split('/')
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** Adapted from DSH-better-sidebar upload.ts; see UPSTREAM.md and LICENSE. */
export async function fileManagerDropItems(data: DataTransfer): Promise<FileManagerUploadItem[]> {
    // Capture handles before the drop event ends and DataTransfer becomes protected.
    const entries = [...data.items].filter(item => item.kind === 'file')
        .map(item => item.webkitGetAsEntry?.() ?? null).filter((entry): entry is FileSystemEntry => entry !== null)
    const fallback = entries.length ? [] : fileManagerUploadItems([...data.files])
    const items: FileManagerUploadItem[] = []
    let visited = 0
    const walk = async (entry: FileSystemEntry, parent: string, depth: number): Promise<void> => {
        if (++visited > 20_000 || depth > 64) throw new Error('The dropped folder is too large to inspect.')
        if (!validFileManagerName(entry.name)) throw new Error(`Invalid upload path: ${entry.name}`)
        const relativePath = fileManagerJoin(parent, entry.name)
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
            items.push({ file, relativePath })
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            for (;;) {
                const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
                if (!batch.length) break
                for (const child of batch) await walk(child, relativePath, depth + 1)
            }
        }
    }
    for (const entry of entries) await walk(entry, '', 0)
    return entries.length ? items : fallback
}
