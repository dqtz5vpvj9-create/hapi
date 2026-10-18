declare module 'diff' {
    export type Change = {
        value: string
        added?: boolean
        removed?: boolean
    }

    export function diffLines(oldStr: string, newStr: string): Change[]

    export type ParsedHunk = {
        oldStart: number
        oldLines: number
        newStart: number
        newLines: number
        lines: string[]
    }
    export function parsePatch(unifiedDiff: string): Array<{
        oldFileName?: string
        newFileName?: string
        hunks: ParsedHunk[]
    }>
}

