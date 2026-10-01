import { describe, expect, it } from 'vitest'
import fixture from '../../../shared/fixtures/chat/sidechain-task-nested-children.json'
import { isObject } from '@hapi/protocol'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from './types'

describe('reading parallel subagent conversations', () => {
    it('keeps the two subagent conversations under their respective calls even when both calls share an assistant message', () => {
        const messages = (fixture.input.messages as DecryptedMessage[]).map(normalizeDecryptedMessage)
            .filter((message): message is NormalizedMessage => message !== null)
        const parent = messages[1]
        if (parent.role !== 'agent') throw new Error('Fixture must contain an assistant call message')
        const firstCall = parent.content.find(part => part.type === 'tool-call')
        if (!firstCall || firstCall.type !== 'tool-call') throw new Error('Fixture must contain a Task call')
        parent.content.push({ ...firstCall, id: 'task-second',
            input: { ...(isObject(firstCall.input) ? firstCall.input : {}), prompt: 'Second independent task' } })
        const secondChildren = messages.filter(message => message.isSidechain).map(message => {
            if (message.role !== 'agent') throw new Error('Fixture children must be agent messages')
            return { ...message, id: `second-${message.id}`, parentToolUseId: 'task-second', content: message.content.map(part => {
                const identity = 'uuid' in part ? { uuid: `second-${part.uuid}`, parentUUID: part.parentUUID ? `second-${part.parentUUID}` : null } : {}
                if (part.type === 'tool-call') return { ...part, ...identity, id: `second-${part.id}` }
                if (part.type === 'tool-result') return { ...part, ...identity, tool_use_id: `second-${part.tool_use_id}` }
                return { ...part, ...identity }
            }) } satisfies NormalizedMessage
        })
        const result = reduceChatBlocks([...messages, ...secondChildren], null)
        const first = result.blocks.find(block => block.kind === 'tool-call' && block.id === firstCall.id)
        const second = result.blocks.find(block => block.kind === 'tool-call' && block.id === 'task-second')
        expect(first?.kind === 'tool-call' ? first.children.map(child => child.id) : null)
            .toEqual(['msg-agent-604:0', 'toolu_01ScGrepRetry01', 'msg-agent-607:0'])
        expect(second?.kind === 'tool-call' ? second.children.map(child => child.id) : null)
            .toEqual(['second-msg-agent-604:0', 'second-toolu_01ScGrepRetry01', 'second-msg-agent-607:0'])
    })
})
