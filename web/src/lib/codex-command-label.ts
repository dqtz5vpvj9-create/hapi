import { isObject } from '@hapi/protocol'

/** Display only. Full command and output remain untouched in the detail view. */
export function getCodexCommandText(input: unknown): string | null {
    if (!isObject(input)) return null
    const value = input.command ?? input.cmd
    if (typeof value === 'string') return value.trim() || null
    if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return null
    // Native exec often sends ["/bin/bash", "-lc", "actual command"].
    if (value.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(value[0]) && /^-[a-z]*c[a-z]*$/i.test(value[1])) {
        return value[2].trim() || null
    }
    return value.join(' ').trim() || null
}

export function singleLineCommand(command: string): string {
    return command.replace(/\r\n|\r|\n/g, ' ↵ ').replace(/\t/g, ' ')
}
