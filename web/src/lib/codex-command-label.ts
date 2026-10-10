import { isObject } from '@hapi/protocol'

function isPowerShell(executable: string): boolean {
    return /^(?:pwsh|powershell)(?:\.exe)?$/i.test(executable.split(/[\\/]/).at(-1) ?? '')
}

/** Remove only a single enclosing argument quote, never quotes inside the script. */
function unwrapArgument(value: string): string {
    const quote = value[0]
    if (quote !== '"' && quote !== "'") return value
    for (let index = 1; index < value.length; index++) {
        if ((value[index] === '`' || value[index] === '\\') && value[index + 1] === quote) {
            index++
            continue
        }
        if (value[index] !== quote) continue
        if (value[index + 1] === quote) {
            index++
            continue
        }
        return index === value.length - 1 ? value.slice(1, -1) : value
    }
    return value
}

function displayString(value: string): string | null {
    const command = value.trim()
    // Exec transports also serialize Windows argv into one string. Recognize
    // only a real PowerShell executable and harmless startup switches. Do not
    // strip arbitrary programs, -File, encoded commands or unknown options.
    const wrapper = /^(?:&\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(command)
    if (wrapper && isPowerShell(wrapper[1] ?? wrapper[2] ?? wrapper[3])) {
        return unwrapArgument(wrapper[4]).trim() || command
    }
    return command || null
}

/** Display only. Full command and output remain untouched in the detail view. */
export function getCodexCommandText(input: unknown): string | null {
    if (!isObject(input)) return null
    const value = input.command ?? input.cmd
    if (typeof value === 'string') return displayString(value)
    if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) return null
    // Native exec often sends ["/bin/bash", "-lc", "actual command"].
    if (value.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(value[0]) && /^-[a-z]*c[a-z]*$/i.test(value[1])) {
        return value[2].trim() || null
    }
    if (isPowerShell(value[0] ?? '')) {
        let index = 1
        while (/^-(?:NoLogo|NoProfile|NonInteractive)$/i.test(value[index] ?? '')) index++
        if (/^-(?:Command|c)$/i.test(value[index] ?? '') && index === value.length - 2) {
            return value[index + 1].trim() || null
        }
    }
    return value.join(' ').trim() || null
}

export function singleLineCommand(command: string): string {
    return command.replace(/\r\n|\r|\n/g, ' ↵ ').replace(/\t/g, ' ')
}
