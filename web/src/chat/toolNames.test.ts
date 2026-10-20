import { describe, expect, it } from 'vitest'
import { canonicalToolName } from '@/chat/toolNames'

describe('canonicalToolName', () => {
    it('maps lowercase ACP names to the names used by the tool views', () => {
        expect(canonicalToolName('bash')).toBe('Bash')
        expect(canonicalToolName('read')).toBe('Read')
        expect(canonicalToolName('edit')).toBe('Edit')
        expect(canonicalToolName('write')).toBe('Write')
        expect(canonicalToolName('grep')).toBe('Grep')
    })

    it('keeps canonical and unrelated names untouched', () => {
        expect(canonicalToolName('Bash')).toBe('Bash')
        expect(canonicalToolName('mcp__hapi__change_title')).toBe('mcp__hapi__change_title')
        expect(canonicalToolName('unknown_tool')).toBe('unknown_tool')
        expect(canonicalToolName('')).toBe('')
    })
})
