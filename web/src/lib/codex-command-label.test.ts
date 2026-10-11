import { describe, expect, it } from 'vitest'
import { getCodexCommandText, singleLineCommand } from './codex-command-label'

describe('Codex command labels', () => {
    it('handles text, cmd and native shell argv without fabricating a command', () => {
        expect(getCodexCommandText({ command: 'ls -ld /home/chris/.agentsview /android; df -h' })).toBe('ls -ld /home/chris/.agentsview /android; df -h')
        expect(getCodexCommandText({ command: ['/bin/bash', '-lc', 'git status --short'] })).toBe('git status --short')
        expect(getCodexCommandText({ command: ['python', '-c', 'print(1)'] })).toBe('python -c print(1)')
        expect(getCodexCommandText({ cmd: 'pwd' })).toBe('pwd')
        expect(getCodexCommandText({ command: [{ unsafe: true }] })).toBeNull()
    })
    it('keeps multiline commands to a single display line without changing quoted whitespace', () => {
        expect(singleLineCommand('echo "two  spaces"\n\tpwd')).toBe('echo "two  spaces" ↵  pwd')
    })
})

describe('PowerShell entry-point prefixes', () => {
    it.each([
        ['"c:\\progra~1\\powers~1\\7\\pwsh.exe" -Command "rg \'needle\' src"', "rg 'needle' src"],
        ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command "Get-Content -LiteralPath \'docs/report.md\'"', "Get-Content -LiteralPath 'docs/report.md'"],
        ["powershell.exe -NonInteractive -Command 'node script.js'", 'node script.js'],
        ['& "C:\\Tools\\PWSH.EXE" -c "git status --short"', 'git status --short'],
        ['/usr/bin/pwsh -Command rg needle src', 'rg needle src'],
        ['pwsh -Command "Get-Content file.txt"; Write-Output "done"', '"Get-Content file.txt"; Write-Output "done"'],
        ["pwsh -Command 'Write-Output ''two spaces'''", "Write-Output ''two spaces''"],
    ])('summarizes %s', (command, expected) => {
        const input = { command }
        expect(getCodexCommandText(input)).toBe(expected)
        expect(input.command).toBe(command)
    })

    it('supports native PowerShell argv and cmd input', () => {
        expect(getCodexCommandText({ command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', "rg 'needle' src"] })).toBe("rg 'needle' src")
        expect(getCodexCommandText({ cmd: 'pwsh -c "Get-Content readme.md"' })).toBe('Get-Content readme.md')
    })

    it.each([
        'echo pwsh -Command "hello"',
        'not-pwsh.exe -Command "hello"',
        'pwsh -EncodedCommand aGVsbG8=',
        'pwsh -File script.ps1',
        'pwsh -Unknown -Command "hello"',
        'pwsh -Command "unterminated',
    ])('does not hide non-wrapper content in %s', (command) => {
        const expected = command === 'pwsh -Command "unterminated' ? '"unterminated' : command
        expect(getCodexCommandText({ command })).toBe(expected)
    })
})
