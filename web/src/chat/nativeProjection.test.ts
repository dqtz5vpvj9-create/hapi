import { describe, expect, it, vi } from 'vitest'
import type { NativeExecution } from '@hapi/protocol/nativeExecution'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { reconcileChatBlocks } from './reconcile'
import { NativeChatProjection } from './nativeProjection'
import type { ChatBlock } from './types'

const scope = { threadId: 'native-thread', turnId: 'native-turn' }
function row(id: string, body: object, itemId?: string, phase?: NativeExecution['phase']): DecryptedMessage {
    return { id, localId: id, seq: Number(id.replace(/\D/g, '')) || 1, createdAt: 1000, invokedAt: 1000,
        content: { role: 'agent', content: { type: 'codex', data: {
            id, nativeExecution: { ...scope, itemId, phase }, ...body,
        } } } } as DecryptedMessage
}
function stateRow(status: string): DecryptedMessage {
    return row('state9', { type: 'native-turn', nativeExecution: {
        ...scope, turn: { status, started: true, ended: status !== 'inProgress' },
    } })
}
const user = () => ({ id: 'input1', localId: 'input1', seq: 1, createdAt: 999, invokedAt: 999,
    content: { role: 'user', content: { type: 'text', text: 'Apply the change' },
        meta: { nativeExecution: { ...scope, itemId: 'input1' } } } } as DecryptedMessage)
const comment = () => row('comment2', { type: 'message', message: 'Checking the requested change.', streamSnapshot: true }, 'comment', 'commentary')
const answer = (text = 'The requested change is complete.') => row('answer5', { type: 'message', message: text, streamSnapshot: true }, 'answer', 'final_answer')
function harness() {
    const projection = new NativeChatProjection()
    let previous = new Map<string, ChatBlock>()
    const normalizedCache = new WeakMap<DecryptedMessage, ReturnType<typeof normalizeDecryptedMessage>>()
    return { projection, apply(rows: DecryptedMessage[], agentState: Parameters<typeof reduceChatBlocks>[1] = null) {
        const normalized = rows.flatMap(row => {
            if (!normalizedCache.has(row)) normalizedCache.set(row, normalizeDecryptedMessage(row))
            const value = normalizedCache.get(row)
            return value ? [value] : []
        })
        const reduced = reduceChatBlocks(normalized, agentState, {})
        const reconciled = reconcileChatBlocks(reduced.blocks, previous)
        previous = reconciled.byId
        projection.update(reconciled.blocks, normalized)
        projection.publish()
        return projection.order.map(key => projection.get(key)!)
    } }
}

describe('native transcript replay', () => {
    it('retains the visible process seat and expansion when earlier tools join a partial page', () => {
        const h = harness()
        const tools = [2, 3, 4].map(index => row(`tool${index}`, {
            type: 'tool-call', name: 'CodexBash', callId: `command${index}`, input: { command: 'pwd' },
        }, `command${index}`))
        const state = stateRow('inProgress')
        const initial = h.apply([...tools.slice(1), state]).filter(node => !node.hidden)
        expect(initial).toHaveLength(1)
        expect(h.projection.getRuntimeBlocks()).toHaveLength(0)
        const seat = initial[0]
        expect(seat.group).toMatchObject({ control: true, count: 2, open: false })
        const prepended = h.apply([...tools, state]).filter(node => !node.hidden)
        expect(prepended).toHaveLength(1)
        expect(prepended[0].key).toBe(seat.key)
        expect(prepended[0].messageKey).not.toBe(seat.messageKey)
        expect(h.projection.ownerOf(seat.messageKey!)).toBe(seat.key)
        h.projection.setGroupOpen(seat.group!.key, true)
        h.projection.refreshPresentation()
        const expanded = h.projection.order.map(key => h.projection.get(key)!).filter(node => !node.hidden)
        expect(expanded.map(node => node.block.id)).toEqual(['command2', 'command3', 'command4'])
        expect(expanded[0].key).toBe(seat.key)
        expect(expanded[0].group?.open).toBe(true)
        expect(h.projection.getRuntimeBlocks().map(block => block.id)).toEqual(['command2', 'command3', 'command4'])
    })

    it('does not fold an already displayed partial turn when pagination discovers its beginning', () => {
        const h = harness()
        const commentary = comment(), finalAnswer = answer(), state = stateRow('completed')
        h.apply([commentary, finalAnswer, state])
        const existingKey = h.projection.order[0]
        const complete = h.apply([user(), commentary, finalAnswer, state])
        expect(complete.every(node => !node.hidden && !node.process)).toBe(true)
        expect(h.projection.order).toContain(existingKey)
        // This is bounded view state. A fresh entry with the complete turn
        // still uses the reference's normal completed-turn disclosure.
        h.apply([])
        expect(h.apply([user(), comment(), answer(), stateRow('completed')])[1].process?.open).toBe(false)
    })

    it('keeps a permission-first question in the same seat when its native history arrives', () => {
        const h = harness()
        const input = { questions: [{ id: 'review', question: 'Proceed?', options: [] }] }
        const state = { requests: { question: { tool: 'request_user_input', toolCallId: 'request-native', arguments: input, createdAt: 1000 } } }
        const [pending] = h.apply([], state)
        const [received] = h.apply([row('question2', {
            type: 'tool-call', name: 'request_user_input', callId: 'request-native', input,
        }, 'question-item')], state)
        expect(received.key).toBe(pending.key)
        expect(received.block.kind === 'tool-call' && received.block.tool.permission?.id).toBe('question')
        expect(received.hidden).toBe(false)
    })
    it('settles streamed text in the same node while only its keyed subscriber receives the update', () => {
        const h = harness()
        const commentary = comment()
        h.apply([commentary, answer('Part'), stateRow('inProgress')])
        const [commentKey, answerKey] = h.projection.order
        const order = h.projection.order
        const commentChanged = vi.fn(), answerChanged = vi.fn()
        h.projection.source(commentKey).subscribe(commentChanged)
        h.projection.source(answerKey).subscribe(answerChanged)
        const durable = { ...answer(), id: 'persisted-native-item' }
        h.apply([commentary, durable, stateRow('inProgress')])
        expect(h.projection.order).toBe(order)
        expect(commentChanged).not.toHaveBeenCalled()
        expect(answerChanged).toHaveBeenCalledTimes(1)
        expect(h.projection.get(answerKey)?.block).toMatchObject({ text: 'The requested change is complete.' })
    })

    it('folds a genuinely completed process, keeps its answer seat, and releases evicted view state', () => {
        const h = harness()
        const [, process, final] = h.apply([user(), comment(), answer(), stateRow('completed')])
        expect(process.process).toMatchObject({ open: false, control: true })
        expect(final.process).toBeUndefined()
        expect(final.hidden).toBe(false)
        expect(h.projection.getRuntimeBlocks().map(block => block.kind)).toEqual(['user-text', 'agent-text'])
        h.projection.setOpen(process.process!.key, process.process!.answer, true)
        h.projection.refreshPresentation()
        expect(h.projection.get(final.key)).toBe(final)
        expect(h.projection.get(process.key)?.process?.open).toBe(true)
        h.projection.disclosureState.set(process.block.id, true)
        h.apply([])
        expect(h.projection.disclosureState.size).toBe(0)
        expect(h.projection.order).toHaveLength(0)
    })

    it('shows one answer when the durable envelope arrives before its live mirror is removed', () => {
        const h = harness()
        const live = answer('Partial output')
        h.apply([live])
        const key = h.projection.order[0]
        const durable = { ...answer(), id: 'persisted-answer', seq: 8 }
        h.apply([live, durable, stateRow('completed')])
        expect(h.projection.order).toEqual([key])
        expect(h.projection.blocks).toHaveLength(1)
        expect(h.projection.get(key)?.block).toMatchObject({ text: 'The requested change is complete.' })
        expect(h.projection.ownerOf('agent-text:persisted-answer')).toBe(key)
    })

    it.each(['inProgress', 'failed', 'interrupted'])('keeps %s process content reachable', status => {
        const nodes = harness().apply([comment(), answer(), stateRow(status)])
        expect(nodes.every(node => !node.hidden && !node.process)).toBe(true)
    })

    it('requires both an authoritative end and an explicit final answer before whole-turn folding', () => {
        const h = harness()
        for (const rows of [[comment(), answer()], [comment(), answer(), stateRow('completed')], [user(), comment(), stateRow('completed')],
            [row('unknown2', { type: 'message', message: 'Unknown phase' }, 'unknown'), answer(), stateRow('completed')]]) {
            expect(h.apply(rows).every(node => !node.hidden && !node.process)).toBe(true)
        }
    })

    it('keeps steered input, approvals, plans and subagent entry points outside folded work', () => {
        const h = harness()
        const input = { id: 'input3', localId: 'input3', seq: 3, createdAt: 1001, invokedAt: 1001,
            content: { role: 'user', content: { type: 'text', text: 'Change the approach' },
                meta: { nativeExecution: { ...scope, itemId: 'input' } } } } as DecryptedMessage
        const interrupted = h.apply([comment(), input, answer(), stateRow('completed')])
        expect(interrupted.every(node => !node.process)).toBe(true)
        const calls = ['request_user_input', 'ExitPlanMode', 'spawn_agent'].map((name, index) =>
            row(`tool${index + 3}`, { type: 'tool-call', name, callId: name, input: {} }, name))
        const nodes = h.apply([comment(), ...calls, answer(), stateRow('completed')])
        for (const node of nodes.filter(node => node.block.kind === 'tool-call')) {
            expect(node.hidden).toBe(false)
            expect(node.process).toBeUndefined()
            expect(node.group).toBeUndefined()
        }
    })
})
