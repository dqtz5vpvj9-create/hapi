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
