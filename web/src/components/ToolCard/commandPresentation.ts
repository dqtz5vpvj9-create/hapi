import type { ChatToolCall } from '@/chat/types'
import { isObject } from '@hapi/protocol'

export type CommandPreview = {
    text: string
    hiddenLineCount: number
    truncated: boolean
}

export type CommandPresentation = {
    command: string | null
    cwd: string | null
    stdout: string | null
    stderr: string | null
    /** Plain output content, without serializing transport metadata as JSON. */
    output: string | null
    exitCode: number | null
    isError: boolean
    outputState: 'available' | 'empty' | 'unavailable' | 'deferred'
    preview: CommandPreview | null
}

type CommandResult = Pick<CommandPresentation, 'stdout' | 'stderr' | 'output' | 'exitCode' | 'isError'> & {
    empty: boolean
    errorPreviewOutput: string | null
}

const PREVIEW_LINES = 2
const PREVIEW_LINE_LENGTH = 300
const FAILED_STATUSES = new Set(['error', 'failed', 'failure', 'declined', 'incomplete', 'aborted', 'canceled', 'cancelled', 'timed_out', 'timeout'])
const FINISHED_STATUSES = new Set(['completed', 'succeeded', 'success', 'done', ...FAILED_STATUSES])
const EMPTY_RESULT: CommandResult = { stdout: null, stderr: null, output: null, exitCode: null, isError: false, empty: false, errorPreviewOutput: null }

function stringField(value: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) if (typeof value[key] === 'string') return value[key]
    return null
}

function commandText(input: unknown): string | null {
    if (typeof input === 'string') return input || null
    if (!isObject(input)) return null
    const value = input.command ?? input.cmd
    if (typeof value === 'string') return value || null
    if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === 'string')) return null
    // This is an unambiguous argv display, not a reconstructed executable shell
    // script. Preserve argument boundaries and every shell startup argument;
    // the original structured input remains available in the full detail view.
    return value.map(part => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part)).join(' ')
}

function joinOutput(parts: Array<string | null>): string | null {
    const present = parts.filter((part): part is string => part !== null)
    if (!present.length) return null
    const nonempty = present.filter(part => part.length > 0)
    return nonempty.reduce((joined, part) => joined
        ? joined + (joined.endsWith('\n') || part.startsWith('\n') ? '' : '\n') + part
        : part, '')
}

function resultText(text: string): CommandResult {
    const toolError = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(text)
    if (toolError) return { ...EMPTY_RESULT, output: toolError[1], isError: true, empty: !toolError[1] }

    // These are transport wrappers, not arbitrary mentions of an exit code in
    // command output. In particular, never parse metadata out of stdout/stderr.
    const envelope = /^(?:(?:Wall time|Chunk ID|Original token count|Total output lines):[^\r\n]*\r?\n)*(?:Exit code:\s*(-?\d+)|Process exited with code\s+(-?\d+))\r?\n(?:(?:Wall time|Original token count|Total output lines):[^\r\n]*\r?\n)*(?:Output|Final output):\r?\n([\s\S]*)$/.exec(text)
    if (envelope) {
        const exitCode = Number(envelope[1] ?? envelope[2])
        return { ...EMPTY_RESULT, output: envelope[3], exitCode, isError: exitCode !== 0, empty: !envelope[3] }
    }
    return { ...EMPTY_RESULT, output: text, empty: !text }
}

function extractResult(result: unknown, depth = 0): CommandResult {
    if (depth > 4 || result === null || result === undefined) return EMPTY_RESULT
    if (typeof result === 'string') return resultText(result)
    if (Array.isArray(result)) {
        const texts: string[] = []
        let exitCode: number | null = null
        let isError = false
        for (const part of result) {
            const text = typeof part === 'string' ? part
                : isObject(part) && (part.type === 'text' || part.type === undefined) && typeof part.text === 'string' ? part.text : null
            if (text === null) continue
            const parsed = resultText(text)
            if (parsed.output !== null) texts.push(parsed.output)
            exitCode ??= parsed.exitCode
            isError ||= parsed.isError
        }
        const output = texts.length ? texts.join('\n') : result.length ? null : ''
        return { ...EMPTY_RESULT, output, exitCode, isError, empty: output === '' }
    }
    if (!isObject(result)) return EMPTY_RESULT

    const rawExitCode = result.exit_code ?? result.exitCode ?? result.exitcode
    const ownExitCode = typeof rawExitCode === 'number' && Number.isFinite(rawExitCode) && Number.isInteger(rawExitCode) ? rawExitCode : null
    const status = typeof result.status === 'string' ? result.status.toLowerCase() : null
    const ownStdout = stringField(result, ['stdout'])
    const ownStderr = stringField(result, ['stderr'])
    const aggregate = stringField(result, ['aggregatedOutput', 'aggregated_output'])
    // Native Codex emits both stdout and output with identical contents. A
    // direct stream wins over that alias; structured output still gets read.
    const directOutput = stringField(result, ['output'])
    let nested = EMPTY_RESULT
    let nestedExitCode: number | null = null
    let nestedIsError = false
    for (const key of ['output', 'result', 'data', 'content', 'text']) {
        const value = result[key]
        if (key === 'output' && typeof value === 'string') continue
        const parsed = extractResult(value, depth + 1)
        nestedExitCode ??= parsed.exitCode
        nestedIsError ||= parsed.isError
        if (nested === EMPTY_RESULT || (nested.output === null && parsed.output !== null)) nested = parsed
        if (parsed.output !== null) break
    }
    const error = extractResult(result.error, depth + 1)
    const message = typeof result.message === 'string' ? result.message : null
    const stdout = ownStdout ?? aggregate ?? (directOutput !== null ? directOutput : nested.stdout)
    const stderr = ownStderr ?? nested.stderr
    let output: string | null
    let errorPreviewOutput: string | null
    if (ownStdout !== null || ownStderr !== null || aggregate !== null || directOutput !== null) {
        // Empty stdout must not swallow a separately supplied diagnostic.
        const body = stdout || aggregate || directOutput || nested.output || stdout
        const diagnostic = error.output && error.output !== body && error.output !== stderr ? error.output : null
        output = joinOutput([body, stderr, diagnostic])
        errorPreviewOutput = joinOutput([stderr, body, diagnostic])
    } else {
        output = nested.output ?? error.output ?? message
        errorPreviewOutput = nested.errorPreviewOutput
    }
    const exitCode = ownExitCode ?? nestedExitCode ?? error.exitCode
    const isError = result.is_error === true || result.isError === true || result.success === false
        || Boolean(status && FAILED_STATUSES.has(status)) || (exitCode !== null && exitCode !== 0)
        || Boolean(error.output) || nestedIsError || error.isError
    const hasBody = ['output', 'result', 'data', 'content', 'text'].some(key => result[key] !== null && result[key] !== undefined)
    const empty = output === '' || (output === null && (nested.empty
        || (!hasBody && (exitCode !== null || Boolean(status && FINISHED_STATUSES.has(status))))))
    return { stdout, stderr, output, exitCode, isError, empty, errorPreviewOutput }
}

/** Display-only cleanup; the extracted streams and original result stay intact. */
export function cleanCommandOutput(text: string): string {
    return text
        // OSC hyperlinks/window titles and DCS payloads are non-display data.
        // Lazy terminators preserve link labels between adjacent OSC sequences.
        .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
        .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g, '')
        .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b[ -/]*[@-~]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function outputPreview(output: string): CommandPreview | null {
    const text = cleanCommandOutput(output).trimEnd()
    if (!text.trim()) return null
    const lines: string[] = []
    let lineCount = 0
    let truncated = false
    let start = 0
    // Count all lines without constructing an unbounded array for large logs.
    while (start <= text.length) {
        const newline = text.indexOf('\n', start)
        const end = newline === -1 ? text.length : newline
        lineCount++
        if (lines.length < PREVIEW_LINES) {
            let previewEnd = Math.min(end, start + PREVIEW_LINE_LENGTH)
            const shortened = previewEnd < end
            if (shortened && /[\uD800-\uDBFF]/.test(text[previewEnd - 1] ?? '')) previewEnd--
            lines.push(text.slice(start, previewEnd) + (shortened ? '…' : ''))
            truncated ||= shortened
        }
        if (newline === -1) break
        start = newline + 1
    }
    const hiddenLineCount = Math.max(0, lineCount - lines.length)
    return { text: lines.join('\n'), hiddenLineCount, truncated: truncated || hiddenLineCount > 0 }
}

export function getCommandPresentation(
    tool: Pick<ChatToolCall, 'input' | 'result' | 'state'>,
    options: { outputDeferred?: boolean } = {},
): CommandPresentation {
    const result = extractResult(tool.result)
    const isError = tool.state === 'error' || result.isError
    // A failed process's stderr usually contains the actionable diagnostic.
    // Keep stream order in full output; prioritize that diagnostic in summary.
    const previewSource = isError ? result.errorPreviewOutput ?? result.output : result.output
    const preview = previewSource !== null ? outputPreview(previewSource) : null
    const outputState = preview ? 'available' : options.outputDeferred ? 'deferred'
        : result.empty || result.output !== null ? 'empty' : 'unavailable'
    return {
        command: commandText(tool.input),
        cwd: isObject(tool.input) ? stringField(tool.input, ['cwd', 'workdir', 'working_directory', 'workingDirectory']) : null,
        stdout: result.stdout,
        stderr: result.stderr,
        output: result.output,
        exitCode: result.exitCode,
        isError,
        outputState,
        preview,
    }
}
