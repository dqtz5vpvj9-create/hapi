import { describe, expect, it } from 'vitest'
import { extractConversationOutlineLabel } from '@hapi/protocol/conversationOutline'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { buildConversationOutline } from './outline'

const fixtures = import.meta.glob('../../../shared/fixtures/chat/*.json', { eager: true, import: 'default' })

describe('outline metadata agrees with the production user lane', () => {
    for (const [path, raw] of Object.entries(fixtures)) {
        it(path.split('/').at(-1)!, () => {
            const fixture = raw as { input: { messages: DecryptedMessage[] } }
            for (const message of fixture.input.messages) {
                // Content classification is independent of queued/scheduled state.
                const normalized = normalizeDecryptedMessage({ ...message, invokedAt: message.createdAt })
                const outline = buildConversationOutline(reduceChatBlocks(normalized ? [normalized] : [], null, {}).blocks)
                const indexed = extractConversationOutlineLabel(message.content)
                expect(indexed, message.id).toBe(outline[0]?.label ?? null)
            }
        })
    }
})
