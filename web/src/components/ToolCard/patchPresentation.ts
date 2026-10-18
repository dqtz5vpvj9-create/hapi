import { isObject, safeStringify } from '@hapi/protocol'
import { parsePatch } from 'diff'

export type PatchRow = {
    kind: 'add' | 'del' | 'context' | 'note'
    old?: number
    new?: number
    text: string
}
export type PatchHunk = {
    header: string
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
}
export type PatchFile = { oldPath?: string; newPath?: string; hunks: PatchHunk[] }
export type CodexFileChange = {
    path: string
    kind: 'add' | 'delete' | 'update' | 'unknown'
    movePath?: string
    raw: string
    files: PatchFile[] | null
}

export const MAX_PATCH_RENDERED_LINES = 5000
const MAX_PATCH_PARSE_CHARS = 2_000_000

/** Retain file and hunk boundaries; never reconstruct a dense file from excerpts. */
export function parseUnifiedPatch(raw: string): PatchFile[] | null {
    if (raw.length > MAX_PATCH_PARSE_CHARS) return null
    try {
        const patches = parsePatch(raw)
        const headers = Array.from(raw.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm), match => match[0])
        let headerIndex = 0
        if (!patches.length || !patches.some(file => file.hunks.length)) return null
        const files = patches.map(file => ({
            oldPath: file.oldFileName,
            newPath: file.newFileName,
            hunks: file.hunks.map(hunk => {
                if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => Number.isSafeInteger(value) && value >= 0)) {
                    throw new Error('Invalid hunk range')
                }
                const header = headers[headerIndex++]
                if (!header) throw new Error('Missing hunk header')
                return { ...hunk, header }
            })
        }))
        return headerIndex === headers.length ? files : null
    } catch {
        return null
    }
}

/** Adapted from DSH FileDiff.hunkRows (MIT); see dsh/UPSTREAM.md. */
export function patchHunkRows(hunk: PatchHunk): PatchRow[] {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    return hunk.lines.map(line => {
        const text = line.slice(1)
        switch (line[0]) {
            case '+': return { kind: 'add', new: newNo++, text }
            case '-': return { kind: 'del', old: oldNo++, text }
            // A no-newline marker describes the preceding line; it consumes no number.
            case '\\': return { kind: 'note', text: line }
            default: return { kind: 'context', old: oldNo++, new: newNo++, text }
        }
    })
}

/** One budget spans all hunks and files, without changing their source ranges. */
export function capPatchFiles(files: PatchFile[], budget = MAX_PATCH_RENDERED_LINES): { files: PatchFile[]; truncated: boolean } {
    let remaining = budget
    let truncated = false
    return {
        files: files.map(file => ({ ...file, hunks: file.hunks.flatMap(hunk => {
            const keep = Math.min(remaining, hunk.lines.length)
            remaining -= keep
            if (keep < hunk.lines.length) truncated = true
            return keep > 0 ? [{ ...hunk, lines: hunk.lines.slice(0, keep) }] : []
        }) })),
        truncated
    }
}

function contentPatch(content: string, kind: 'add' | 'delete'): PatchFile[] | null {
    if (content.length > MAX_PATCH_PARSE_CHARS) return null
    const lines = content === '' ? [] : content.split('\n')
    if (content.endsWith('\n')) lines.pop()
    return [{ hunks: [{
        header: kind === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
        oldStart: 1, newStart: 1,
        oldLines: kind === 'delete' ? lines.length : 0,
        newLines: kind === 'add' ? lines.length : 0,
        lines: lines.map(line => `${kind === 'add' ? '+' : '-'}${line}`)
    }] }]
}

function fileChange(path: string, value: unknown, parse: boolean): CodexFileChange {
    const unknown = (): CodexFileChange => ({ path, kind: 'unknown', raw: typeof value === 'string' ? value : safeStringify(value), files: null })
    if (!isObject(value)) return unknown()
    // Official app-server FileUpdateChange and legacy protocol FileChange only.
    const v2 = isObject(value.kind) ? value.kind : null
    const kind = v2 ? v2.type : value.type
    if (kind !== 'add' && kind !== 'delete' && kind !== 'update') return unknown()
    const raw = v2 ? value.diff : kind === 'update' ? value.unified_diff : value.content
    if (typeof raw !== 'string') return unknown()
    const movePath = kind === 'update' ? (v2 ? v2.move_path : value.move_path) : undefined
    const move = typeof movePath === 'string' ? movePath : undefined
    // Codex's official format_file_change_diff appends this display annotation.
    // Strip only the exact advertised target, preserving the full copy source.
    const suffix = move ? `\n\nMoved to: ${move}` : undefined
    const unified = v2 && suffix && raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw
    return { path, kind, raw, ...(move ? { movePath: move } : {}),
        files: !parse ? null : kind === 'update' ? parseUnifiedPatch(unified) : contentPatch(raw, kind) }
}

export function codexFileChanges(input: unknown, result?: unknown, parse = true): CodexFileChange[] | null {
    // Completed changes are authoritative, including an explicitly empty map.
    const source = isObject(result) && Object.hasOwn(result, 'changes') ? result.changes : isObject(input) ? input.changes : undefined
    if (source === undefined) return null
    if (Array.isArray(source)) {
        return source.map((value, index) => fileChange(isObject(value) && typeof value.path === 'string' ? value.path : `#${index + 1}`, value, parse))
    }
    if (!isObject(source)) return [{ path: '', kind: 'unknown', raw: safeStringify(source), files: null }]
    return Object.entries(source).map(([path, value]) => fileChange(path, value, parse))
}
