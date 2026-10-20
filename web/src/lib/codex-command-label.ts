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

function shellName(executable: string): string {
    return (executable.split(/[\\/]/).at(-1) ?? '').replace(/\.exe$/i, '').toLowerCase()
}

const unixShells = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish'])

/** Decode one POSIX shell argument without evaluating substitutions or variables. */
function unixArgument(value: string): string | null {
    let quote = '', result = ''
    for (let i = 0; i < value.length; i++) {
        const ch = value[i]
        if (ch === quote) { quote = ''; continue }
        if (!quote && (ch === "'" || ch === '"')) { quote = ch; continue }
        if (!quote && /\s|[;&|<>]/.test(ch)) return null
        if (ch === '\\' && quote !== "'") {
            const next = value[i + 1]
            if (next === undefined) return null
            if (!quote || ['"', '\\', '$', '`', '\n'].includes(next)) {
                if (next !== '\n') result += next
                i++
                continue
            }
        }
        result += ch
    }
    return quote ? null : result
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
    const shell = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(command)
    if (shell) {
        const name = shellName(shell[1] ?? shell[2] ?? shell[3])
        if (unixShells.has(name)) {
            const args = /^(?:(?:--login|--noprofile|--norc|-[il])\s+)*-[il]*c[il]*\s+([\s\S]+)$/.exec(shell[4])
            const script = args ? unixArgument(args[1]) : null
            if (script) return script
        }
        if (name === 'cmd') {
            const args = /^(?:(?:\/[dsq]|\/(?:e|v|f):(?:on|off))\s+)*\/c\s+([\s\S]+)$/i.exec(shell[4])
            if (args) return unwrapArgument(args[1]).trim() || command
        }
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
    if (unixShells.has(shellName(value[0] ?? ''))) {
        let index = 1
        while (/^(?:--login|--noprofile|--norc|-[il])$/.test(value[index] ?? '')) index++
        if (/^-[il]*c[il]*$/.test(value[index] ?? '') && index === value.length - 2) return value[index + 1].trim() || null
    }
    if (shellName(value[0] ?? '') === 'cmd') {
        let index = 1
        while (/^\/(?:[dsq]|(?:e|v|f):(?:on|off))$/i.test(value[index] ?? '')) index++
        if (/^\/c$/i.test(value[index] ?? '') && index === value.length - 2) return value[index + 1].trim() || null
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
