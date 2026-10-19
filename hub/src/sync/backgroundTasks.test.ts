import { describe, expect, it } from 'bun:test'
import { extractBackgroundTaskEvents } from './backgroundTasks'

const output = (data: unknown) => ({ role: 'agent', content: { type: 'output', data } })

describe('background task signals', () => {
    it('extracts stable IDs from direct and SDK user/assistant tool results', () => {
        const block = { type: 'tool_result', content: [{ type: 'text', text: 'Command running in background with ID: bash_1' }] }
        for (const data of [block, { type: 'assistant', message: { content: [block, block] } }, { type: 'user', message: { content: [block] } }]) {
            expect(extractBackgroundTaskEvents(output(data))).toEqual([{ taskId: 'bash_1', state: 'running' }])
        }
    })

    it('reads terminal status by ID without matching ordinary user or assistant prose', () => {
        const text = '<task-notification><task-id>bash_1</task-id><status>failed</status></task-notification>'
        expect(extractBackgroundTaskEvents(output({ type: 'user', message: { content: text } }))).toEqual([{ taskId: 'bash_1', state: 'failed' }])
        expect(extractBackgroundTaskEvents({ role: 'user', content: { type: 'text', text } })).toEqual([])
        expect(extractBackgroundTaskEvents(output({ type: 'assistant', message: { content: [{ type: 'text', text: 'Command running in background with ID: fake' }] } }))).toEqual([])
        expect(extractBackgroundTaskEvents(output({ type: 'user', content: `Please explain ${text}` }))).toEqual([])
    })

    it('ignores completion notifications without a valid ID and parses cancellation', () => {
        expect(extractBackgroundTaskEvents(output({ type: 'user', content: '<task-notification><summary>Finished</summary></task-notification>' }))).toEqual([])
        expect(extractBackgroundTaskEvents(output({ type: 'user', content: '<task-notification><task-id>../bad</task-id></task-notification>' }))).toEqual([])
        expect(extractBackgroundTaskEvents(output({ type: 'user', content: '<task-notification><task-id>bash-2</task-id><status>stopped</status></task-notification>' }))).toEqual([{ taskId: 'bash-2', state: 'cancelled' }])
    })
})
