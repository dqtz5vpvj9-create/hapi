import { describe, expect, it } from 'vitest'
import { extractMessageDependencyFacts, isSubagentToolName, type MessageDependencyFact } from '@hapi/protocol/messageDependencies'
import { isObject } from '@hapi/protocol'
import { normalizeDecryptedMessage } from './normalize'
import type { DecryptedMessage } from '@/types/api'

const fixtures = import.meta.glob('../../../shared/fixtures/chat/*.json', { eager: true, import: 'default' })
const unsupportedOnly = new Set(['agy-message.json', 'agy-tool-action-run-command.json', 'codex-generated-image.json', 'codex-review-verdict.json'])
const order = (facts: MessageDependencyFact[]) => facts.map(fact => JSON.stringify(fact)).sort()

// Compare shared raw-content extraction with the actual chat normalizer, rather
// than encoding expected strings copied from the extractor implementation.
function normalizedFacts(message: DecryptedMessage) {
    const normalized = normalizeDecryptedMessage(message)
    const facts: MessageDependencyFact[] = []
    const add = (kind: MessageDependencyFact['kind'], key: unknown, ordinal = 0) => {
        if (typeof key === 'string') facts.push({ kind, key, ordinal })
    }
    if (normalized?.isSidechain) add('parent_tool_use', normalized.parentToolUseId)
    if (normalized?.role === 'agent') {
        const first = normalized.content[0]
        if (first && 'uuid' in first) add('sdk_uuid', first.uuid)
        if (first && 'parentUUID' in first) add('sdk_parent', first.parentUUID)
        normalized.content.forEach((part, ordinal) => {
            if (part.type === 'tool-call') {
                add('tool_call', part.id, ordinal)
                if (isSubagentToolName(part.name)) {
                    add('subagent_call', part.id, ordinal)
                    if (isObject(part.input)) add('task_prompt', part.input.prompt, ordinal)
                }
            } else if (part.type === 'tool-result') add('tool_result', part.tool_use_id, ordinal)
            else if (part.type === 'sidechain') add('sidechain_prompt', part.prompt, ordinal)
            else if (part.type === 'text') add('text_stream', part.streamId, ordinal)
            else if (part.type === 'reasoning') add('reasoning_stream', part.streamId, ordinal)
        })
    }
    return { isSidechain: normalized?.isSidechain ?? false, facts }
}

describe('history dependency index facts against production chat parsing', () => {
    for (const [path, raw] of Object.entries(fixtures)) {
        it(path.split('/').at(-1)!, () => {
            const fixture = raw as { input: { messages: DecryptedMessage[] } }
            let supported = 0
            for (const message of fixture.input.messages) {
                const extracted = extractMessageDependencyFacts(message.id, message.content)
                if (extracted.status === 'unsupported') continue
                supported++
                const normalized = normalizedFacts(message)
                expect(extracted.isSidechain, `${message.id}: sidechain`).toBe(normalized.isSidechain)
                expect(order(extracted.facts), `${message.id}: relationships`).toEqual(order(normalized.facts))
            }
            if (unsupportedOnly.has(path.split('/').at(-1)!)) expect(supported).toBe(0)
            else expect(supported).toBeGreaterThan(0)
        })
    }

    it('keeps unknown producer formats explicitly unsupported', () => {
        expect(extractMessageDependencyFacts('unknown', { role: 'agent', content: { type: 'new-producer', data: { callId: 'unproven' } } }).status)
            .toBe('unsupported')
    })
})
