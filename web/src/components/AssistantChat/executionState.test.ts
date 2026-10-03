import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/api'
import type { ToolCallBlock } from '@/chat/types'
import { getExecutionPresentation } from './executionState'

const session = { active: true, thinking: true, activeTurnStartedAt: 100, agentState: {} } as Session
function tool(id: string, state: ToolCallBlock['tool']['state'], createdAt = 110): ToolCallBlock {
    return { kind: 'tool-call', id, localId: null, createdAt, children: [], tool: { name: 'Bash', state, startedAt: createdAt, permission: undefined } } as unknown as ToolCallBlock
}
describe('authoritative execution presentation', () => {
    it('animates only the newest running tool, never completed or previous-turn tools', () => {
        expect(getExecutionPresentation(session, [tool('old', 'running', 50), tool('first', 'running', 110), tool('latest', 'running', 120), tool('done', 'completed', 130)], true, true).activeToolId).toBe('latest')
    })
    it('shows thinking only when connected and explicitly thinking without a current running tool', () => {
        expect(getExecutionPresentation(session, [tool('done', 'completed')], true, true).thinking).toBe(true)
        expect(getExecutionPresentation({ ...session, thinking: false }, [], true, true).running).toBe(false)
        expect(getExecutionPresentation(session, [tool('active', 'running')], false, true).running).toBe(false)
    })
    it('stops for permission requests and terminal events despite stale session thinking', () => {
        expect(getExecutionPresentation(session, [tool('failed', 'error')], true, true)).toEqual({ running: true, activeToolId: null, thinking: true })
        expect(getExecutionPresentation(session, [tool('failed', 'error'), tool('repair', 'running', 120)], true, true).activeToolId).toBe('repair')
        const pending = tool('approval', 'running')
        pending.tool.permission = { status: 'pending' } as ToolCallBlock['tool']['permission']
        expect(getExecutionPresentation(session, [pending], true, true).running).toBe(false)
        const historicalPending = { ...pending, createdAt: 50, tool: { ...pending.tool, startedAt: 50 } }
        expect(getExecutionPresentation(session, [historicalPending, tool('current', 'running')], true, true).activeToolId).toBe('current')
        for (const type of ['ready', 'error', 'turn-summary', 'turn-duration']) {
            expect(getExecutionPresentation(session, [{ kind: 'agent-event', id: type, createdAt: 120, event: { type } } as never], true, true).running).toBe(false)
        }
        expect(getExecutionPresentation({ ...session, agentState: { requests: { approval: { tool: 'Bash', arguments: {} } } } } as Session, [], true, true).running).toBe(false)
    })
    it('keeps historical running tools static and exposes only the return affordance', () => {
        expect(getExecutionPresentation(session, [tool('historical', 'running')], true, false)).toEqual({ running: true, activeToolId: null, thinking: false })
    })
    it('uses transcript boundaries when the turn timestamp is absent and recovers for a later turn', () => {
        const untimed = { ...session, activeTurnStartedAt: null }
        const ready = { kind: 'agent-event', id: 'ready', createdAt: 120, event: { type: 'ready' } } as const
        expect(getExecutionPresentation(untimed, [tool('old', 'running'), ready], true, true).running).toBe(false)
        expect(getExecutionPresentation(untimed, [ready, tool('new', 'running', 130)], true, true).activeToolId).toBe('new')
        expect(getExecutionPresentation(untimed, [ready, { kind: 'user-text', id: 'new-user', createdAt: 130 } as never], true, true).thinking).toBe(true)
    })
    it('selects nested and grouped current tools', () => {
        const parent = tool('parent', 'running', 110)
        parent.children = [tool('child', 'running', 120), { kind: 'agent-event', id: 'child-ready', createdAt: 125, event: { type: 'ready' } } as never]
        expect(getExecutionPresentation(session, [parent], true, true).activeToolId).toBe('child')
        expect(getExecutionPresentation(session, [{ kind: 'tool-group', tools: [tool('grouped', 'running')] } as never], true, true).activeToolId).toBe('grouped')
    })
})
