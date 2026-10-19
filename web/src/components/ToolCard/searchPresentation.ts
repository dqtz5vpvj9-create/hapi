import { isObject } from '@hapi/protocol'

export type SearchFileGroup = { path: string; matches: Array<{ lineNumber: number; line: string }> }
export type SearchPresentation = {
    data: { kind: 'paths'; paths: string[] } | { kind: 'matches'; files: SearchFileGroup[] }
    truncated: boolean
    total: number | null
    copyText: string
    recovery?: string
}

function structuredFiles(value: unknown): SearchFileGroup[] | null {
    if (!Array.isArray(value)) return null
    const files: SearchFileGroup[] = []
    for (const file of value) {
        if (!isObject(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) return null
        const matches: SearchFileGroup['matches'] = []
        for (const match of file.matches) {
            if (!isObject(match) || !Number.isSafeInteger(match.lineNumber) || (match.lineNumber as number) < 1 || typeof match.line !== 'string') return null
            matches.push({ lineNumber: match.lineNumber as number, line: match.line })
        }
        files.push({ path: file.path, matches })
    }
    return files
}

function copyStructured(data: SearchPresentation['data']): string {
    return data.kind === 'paths' ? data.paths.join('\n') : data.files.map(file =>
        [file.path, ...file.matches.map(match => `${match.lineNumber}: ${match.line}`)].join('\n')
    ).join('\n\n')
}

export function retainedSearchCount(data: SearchPresentation['data']): number {
    return data.kind === 'paths' ? data.paths.length : data.files.reduce((count, file) => count + file.matches.length, 0)
}

/** DSH metadata shape is source-verified; plain text is accepted only for known Grep/Glob formats. */
export function searchPresentation(name: string, input: unknown, result: unknown, text: string | null, isError: boolean): SearchPresentation | null {
    const tool = name.toLowerCase()
    if (isError || (tool !== 'grep' && tool !== 'glob')) return null
    const candidates = isObject(result) ? [result, result.meta, result.structuredContent] : []
    for (const meta of candidates) {
        if (!isObject(meta) || typeof meta.truncated !== 'boolean' || !Number.isSafeInteger(meta.total) || (meta.total as number) < 0) continue
        let data: SearchPresentation['data'] | null = null
        if (tool === 'glob' && meta.shape === 'paths' && Array.isArray(meta.paths) && meta.paths.every(path => typeof path === 'string')) {
            data = { kind: 'paths', paths: meta.paths as string[] }
        } else if (tool === 'grep' && meta.shape === 'matches') {
            const files = structuredFiles(meta.files)
            if (files) data = { kind: 'matches', files }
        }
        if (!data || (meta.total as number) < retainedSearchCount(data)) return null
        return { data, total: meta.total as number, truncated: meta.truncated, copyText: copyStructured(data),
            ...(meta.truncated && text ? { recovery: text } : {}) }
    }
    if (text === null || text.length > 2_000_000 || /<(?:tool_use_error|error)>/.test(text)) return null
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    while (lines.at(-1) === '') lines.pop()
    if (!lines.length || lines.some(line => /^(?:No (?:files|matches) found|Found \d+|Error:|\.\.\.|\[.*(?:truncated|omitted))/i.test(line))) return null
    if (tool === 'glob') {
        // Lists with headers/Markdown/error annotations retain their generic renderer.
        if (lines.some(line => !line || /^(?:[-*#]|\d+[.)])\s/.test(line) || /[\u0000-\u001f]/.test(line))) return null
        return { data: { kind: 'paths', paths: lines }, total: null, truncated: false, copyText: text }
    }
    if (isObject(input) && (input.output_mode === 'count' || input.output_mode === 'files_with_matches' || input['-n'] === false)) return null
    const files: SearchFileGroup[] = []
    const byPath = new Map<string, SearchFileGroup>()
    for (const line of lines) {
        const match = /^(.+?):([1-9]\d*):(.*)$/.exec(line)
        if (!match || !Number.isSafeInteger(Number(match[2]))) return null
        let file = byPath.get(match[1])
        if (!file) { file = { path: match[1], matches: [] }; byPath.set(file.path, file); files.push(file) }
        file.matches.push({ lineNumber: Number(match[2]), line: match[3] })
    }
    return { data: { kind: 'matches', files }, total: null, truncated: false, copyText: text }
}

export type SearchRow =
    | { type: 'path'; path: string; key: string }
    | { type: 'file'; path: string; count: number; fileIndex: number; collapsed: boolean; key: string }
    | { type: 'match'; lineNumber: number; line: string; fileIndex: number; key: string }

export function searchRows(data: SearchPresentation['data'], collapsed: ReadonlySet<number>): SearchRow[] {
    if (data.kind === 'paths') return data.paths.map((path, index) => ({ type: 'path', path, key: `path:${index}` }))
    return data.files.flatMap((file, fileIndex): SearchRow[] => [
        { type: 'file', path: file.path, count: file.matches.length, fileIndex, collapsed: collapsed.has(fileIndex), key: `file:${fileIndex}` },
        ...(collapsed.has(fileIndex) ? [] : file.matches.map((match, index): SearchRow => ({ ...match, type: 'match', fileIndex, key: `match:${fileIndex}:${index}` })))
    ])
}

/** DSH SearchBlock's bounded head/tail with a restored tail file header; see dsh/UPSTREAM.md. */
export function capSearchRows(rows: SearchRow[], maxRows: number): { head: SearchRow[]; tail: SearchRow[]; hidden: number } {
    if (rows.length <= maxRows) return { head: rows, tail: [], hidden: 0 }
    const head = rows.slice(0, Math.ceil(maxRows / 2))
    const tail = rows.slice(rows.length - Math.floor(maxRows / 2))
    const first = tail[0]
    if (first?.type === 'match' && !head.some(row => row.type === 'file' && row.fileIndex === first.fileIndex)) {
        const header = rows.find(row => row.type === 'file' && row.fileIndex === first.fileIndex)
        if (header) tail.splice(0, 1, header)
    }
    return { head, tail, hidden: rows.length - maxRows }
}
