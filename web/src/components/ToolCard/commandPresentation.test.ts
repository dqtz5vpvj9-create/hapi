import { describe, expect, it } from 'vitest'
import { cleanCommandOutput, getCommandPresentation } from './commandPresentation'

function present(result: unknown, state: 'pending' | 'running' | 'completed' | 'error' = 'completed') {
    return getCommandPresentation({ input: { command: 'bun test', cwd: '/workspace/hapi' }, result, state })
}

describe('command input fidelity', () => {
    it('retains a raw PowerShell command, whitespace and multiline script in detail', () => {
        const command = '  & "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Write-Output \'one\'\nWrite-Output \'two\'"  '
        const value = getCommandPresentation({ input: { command }, state: 'completed' })
        expect(value.command).toBe(command)
    })

    it('retains shell startup arguments and unambiguous argv boundaries', () => {
        const value = getCommandPresentation({
            input: { command: ['/bin/bash', '-lc', 'printf "%s" "$VALUE"', '', 'a b'] },
            state: 'running',
        })
        expect(value.command).toBe('/bin/bash -lc "printf \\"%s\\" \\"$VALUE\\"" "" "a b"')
    })

    it.each([
        ['echo raw', 'echo raw', null],
        [{ cmd: 'git status', workdir: '/repo' }, 'git status', '/repo'],
        [{ command: ['pwsh', '-NoProfile', '-Command', 'Get-ChildItem -Force'], workingDirectory: 'C:\\repo' }, 'pwsh -NoProfile -Command "Get-ChildItem -Force"', 'C:\\repo'],
        [{ command: ['echo', 42] }, null, null],
        [{ command: [] }, null, null],
        [undefined, null, null],
    ])('extracts command input without inventing missing arguments: %j', (input, command, cwd) => {
        const value = getCommandPresentation({ input, state: 'pending' })
        expect(value.command).toBe(command)
        expect(value.cwd).toBe(cwd)
    })
})

describe('command output and process outcome', () => {
    it('extracts the native shared Codex result without duplicating the output alias or showing metadata', () => {
        const value = present({
            type: 'exec_command_end', call_id: 'call-1', command: 'bun test', cwd: '/repo',
            stdout: '420 pass\n', output: '420 pass\n', stderr: 'warning\n', exit_code: 0, status: 'completed',
        })
        expect(value).toMatchObject({
            stdout: '420 pass\n', stderr: 'warning\n', output: '420 pass\nwarning\n', exitCode: 0,
            isError: false, outputState: 'available',
        })
        expect(value.output).not.toContain('call-1')
        expect(value.output?.match(/420 pass/g)).toHaveLength(1)
    })

    it('shows failed process output when the transport completed without is_error', () => {
        const value = present({ stdout: 'collecting\nrunning\nfinished\n', stderr: 'test failed\n', exit_code: 1, status: 'completed' })
        expect(value.isError).toBe(true)
        expect(value.exitCode).toBe(1)
        expect(value.preview).toEqual({ text: 'test failed\ncollecting', hiddenLineCount: 2, truncated: true })
        expect(value.output).toBe('collecting\nrunning\nfinished\ntest failed\n')
    })

    it.each([
        { aggregatedOutput: 'native output', exitCode: 0 },
        { aggregated_output: 'native output', exitcode: 0 },
        { output: { stdout: 'native output', exit_code: 0 } },
        { result: { data: { stdout: 'native output', exitCode: 0 } } },
        { content: [{ type: 'text', text: 'native output' }], exit_code: 0 },
    ])('extracts the actual output from a command result wrapper: %j', result => {
        const value = present(result)
        expect(value.output).toBe('native output')
        expect(value.exitCode).toBe(0)
        expect(value.isError).toBe(false)
    })

    it('preserves both streams even when their content happens to be identical', () => {
        expect(present({ stdout: 'repeated', stderr: 'repeated' }).output).toBe('repeated\nrepeated')
    })

    it('does not lose a structured error behind an empty stdout', () => {
        const value = present({ stdout: '', stderr: '', error: { message: 'spawn failed' }, status: 'failed' })
        expect(value).toMatchObject({ output: 'spawn failed', isError: true, outputState: 'available' })
        expect(value.preview?.text).toBe('spawn failed')
    })

    it('retains a separate error diagnostic in full output and the remaining line count', () => {
        const value = present({ stdout: 'progress\n', stderr: 'warning\n', error: 'spawn failed\n' })
        expect(value.output).toBe('progress\nwarning\nspawn failed\n')
        expect(value.preview).toEqual({ text: 'warning\nprogress', hiddenLineCount: 1, truncated: true })
    })

    it('keeps execution metadata from a wrapper while a sibling supplies its text', () => {
        expect(present({ output: { exit_code: 2, status: 'failed' }, result: { stdout: 'not found' } })).toMatchObject({
            output: 'not found', stdout: 'not found', exitCode: 2, isError: true,
        })
    })

    it('retains literal JSON emitted by a command and never reinterprets its data as process metadata', () => {
        const json = '{"stdout":"payload","exit_code":1}'
        expect(present(json)).toMatchObject({ output: json, exitCode: null, isError: false })
        expect(present({ stdout: json, exit_code: 0 })).toMatchObject({ stdout: json, output: json, exitCode: 0, isError: false })
    })

    it('keeps text parts out of their content-block JSON envelope', () => {
        const value = present({ content: [
            { type: 'text', text: 'first' },
            { type: 'artifact', artifact: { fileName: 'report.pdf' } },
            { type: 'text', text: 'second' },
        ] })
        expect(value.output).toBe('first\nsecond')
    })

    it('extracts an explicit tool-use error wrapper', () => {
        expect(present('<tool_use_error>Permission denied</tool_use_error>')).toMatchObject({
            output: 'Permission denied', isError: true,
        })
    })

    it.each([
        'Wall time: 0.2 seconds\nExit code: 2\nOutput:\npermission denied\n',
        'Chunk ID: abc\nWall time: 0.2 seconds\nProcess exited with code 2\nFinal output:\npermission denied\n',
        'Exit code: 2\nWall time: 0.2 seconds\nOutput:\npermission denied\n',
    ])('separates the command transport envelope from its output', text => {
        expect(present({ content: [{ type: 'text', text }] })).toMatchObject({
            output: 'permission denied\n', exitCode: 2, isError: true,
        })
    })

    it('does not infer failure from incidental output text that mentions an exit code', () => {
        const stdout = 'Exit code: 7\nOutput:\nthis is a test fixture'
        expect(present({ stdout, exit_code: 0 })).toMatchObject({ output: stdout, exitCode: 0, isError: false })
        expect(present('fixture says Exit code: 7')).toMatchObject({ exitCode: null, isError: false })
    })

    it.each(['failed', 'error', 'declined', 'incomplete', 'aborted', 'canceled', 'timed_out'])('preserves terminal failure status %s without an exit code', status => {
        expect(present({ status }).isError).toBe(true)
    })

    it.each([{ is_error: true }, { isError: true }, { success: false }, { exit_code: -1 }])('respects an explicit process failure: %j', result => {
        expect(present(result).isError).toBe(true)
    })

    it('keeps a tool error visible even when its exit code was zero', () => {
        expect(present({ exit_code: 0 }, 'error').isError).toBe(true)
    })

    it.each([NaN, Infinity, 1.2, '1'])('does not invent an exit code from invalid metadata %j', exitCode => {
        expect(present({ exitCode }).exitCode).toBeNull()
    })
})

describe('bounded output summaries', () => {
    it('shows two lines with an exact remaining line count and retains the full output', () => {
        const output = 'line one\nline two\nline three\nline four\n'
        const value = present(output)
        expect(value.preview).toEqual({ text: 'line one\nline two', hiddenLineCount: 2, truncated: true })
        expect(value.output).toBe(output)
    })

    it('cleans color, hyperlinks, terminal controls and CRLF only for display', () => {
        const output = '\u001b[31mfailed\u001b[0m\r\n\u001b]8;;https://example.test\u001b\\link label\u001b]8;;\u001b\\\u0000\u0007'
        const value = present({ stdout: output })
        expect(value.preview).toEqual({ text: 'failed\nlink label', hiddenLineCount: 0, truncated: false })
        expect(value.stdout).toBe(output)
        expect(value.output).toBe(output)
    })

    it('cleans cursor controls, DCS data and unterminated OSC payloads without leaking control syntax', () => {
        expect(cleanCommandOutput('\u001b[2Khello\u009b?25l\u001bPpayload\u001b\\ world\u001b]title')).toBe('hello world')
    })

    it('bounds huge lines without breaking a surrogate pair or deleting the raw result', () => {
        const output = `${'a'.repeat(299)}😀${'z'.repeat(20_000)}\nnext\nlast`
        const value = present(output)
        expect(value.preview).toEqual({ text: `${'a'.repeat(299)}…\nnext`, hiddenLineCount: 1, truncated: true })
        expect(value.output).toBe(output)
    })

    it('counts large logs without retaining the omitted lines in the preview', () => {
        const value = present('line\n'.repeat(30_000))
        expect(value.preview).toEqual({ text: 'line\nline', hiddenLineCount: 29_998, truncated: true })
    })

    it('does not call missing or deferred result bodies empty', () => {
        expect(present(undefined).outputState).toBe('unavailable')
        expect(present(null, 'running').outputState).toBe('unavailable')
        expect(present({ arbitrary: 'metadata' }).outputState).toBe('unavailable')
        const deferred = getCommandPresentation({ input: {}, result: undefined, state: 'completed' }, { outputDeferred: true })
        expect(deferred.outputState).toBe('deferred')
        expect(deferred.preview).toBeNull()
    })

    it('shows available partial output while additional native details are deferred', () => {
        const value = getCommandPresentation({ input: {}, result: { stdout: 'partial output' }, state: 'running' }, { outputDeferred: true })
        expect(value.outputState).toBe('available')
        expect(value.preview?.text).toBe('partial output')
    })

    it.each(['', { stdout: '', stderr: '', exit_code: 0 }, { status: 'completed', exit_code: 0 }, { content: [] }])('recognizes a confirmed empty completion: %j', result => {
        expect(present(result).outputState).toBe('empty')
        expect(present(result).preview).toBeNull()
    })

    it('does not claim a non-text attachment has no output', () => {
        expect(present({ status: 'completed', content: [{ type: 'artifact', artifact: { fileName: 'report.pdf' } }] }).outputState).toBe('unavailable')
    })

    it('bounds unknown cyclic or deeply wrapped result structures', () => {
        const result: Record<string, unknown> = {}
        result.output = result
        expect(present(result).outputState).toBe('unavailable')
    })
})
