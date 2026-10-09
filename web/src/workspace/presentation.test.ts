import { describe, expect, it } from 'vitest'
import { workspaceChatTarget, workspacePresentation } from './presentation'

describe('persistent presentation mode', () => {
    it('uses the saved choice for ordinary and legacy session URLs', () => {
        for (const url of ['/sessions', '/sessions/chat-1', '/sessions/workspace', '/sessions/new', '/sessions/chat-1/files']) {
            expect(workspacePresentation('workspace', url)).toBe(true)
            expect(workspacePresentation('single', url)).toBe(false)
        }
        expect(workspacePresentation('workspace', '/settings')).toBe(false)
    })
    it('extracts chat destinations without mistaking tools or actions for chats', () => {
        expect(workspaceChatTarget('/sessions/chat-1')).toBe('chat-1')
        expect(workspaceChatTarget('/sessions/a%20b/')).toBe('a b')
        for (const url of ['/sessions', '/sessions/new', '/sessions/workspace', '/sessions/chat-1/file', '/sessions/%XY']) {
            expect(workspaceChatTarget(url)).toBeNull()
        }
    })
})
