import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { traceMessages } from './tracer'
import { reduceTimeline } from './reducerTimeline'
import { getEventPresentation } from './presentation'
import type { DecryptedMessage } from '@/types/api'

it('renders the persisted native stop envelope as a status event, never assistant text', () => {
    // Exact existing sendSessionEvent wire path used by the shared projection.
    const row = {
        id: 'stored-stop', localId: 'codex:thread:turn:turn_aborted', createdAt: 1000,
        content: { role: 'agent', content: { id: 'codex:thread:turn:turn_aborted', type: 'event', data: { type: 'message', message: 'Aborted by user' } } },
    } as DecryptedMessage
    const normalized = normalizeDecryptedMessage(row)!
    expect(normalized.role).toBe('event')
    const timeline = reduceTimeline(traceMessages([normalized]), {
        permissionsById: new Map(), groups: new Map(), consumedGroupIds: new Set(), titleChangesByToolUseId: new Map(), emittedTitleChangeToolUseIds: new Set(),
    })
    expect(timeline.blocks).toHaveLength(1)
    const block = timeline.blocks[0]
    expect(block.kind).toBe('agent-event')
    if (block.kind !== 'agent-event') throw new Error('Expected durable status event')
    expect(getEventPresentation(block.event).text).toContain('Aborted')
    expect(timeline.blocks.some(item => item.kind === 'agent-text')).toBe(false)
})
