import { describe, expect, test } from 'vitest'
import { ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES, VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES, utf8ByteLength } from '@hapi/protocol/voice-personality'
import { buildSessionVoiceContextPlan } from './voiceContextPlan'
import type { DecryptedMessage, Session } from '@/types/api'

function makeSession(id: string): Session {
    return {
        id,
        metadata: {
            path: '/proj',
            summary: { text: 'Auth refactor' }
        }
    } as Session
}

function makeMessage(seq: number, text: string): DecryptedMessage {
    return {
        seq,
        content: { type: 'output', data: { type: 'assistant', message: { content: text } } }
    } as DecryptedMessage
}

describe('buildSessionVoiceContextPlan', () => {
    test('bootstrap stays small and defers older messages', () => {
        const session = makeSession('sess-1')
        const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i + 1, `line ${i + 1}`))

        const plan = buildSessionVoiceContextPlan(session, messages, 'Codex')

        expect(plan.bootstrap).toContain('sess-1')
        expect(plan.bootstrap).toContain('Auth refactor')
        expect(utf8ByteLength(plan.bootstrap)).toBeLessThanOrEqual(ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
        expect(plan.streamChunks.length).toBeGreaterThan(0)
        expect(plan.messagesInBootstrap).toBeLessThanOrEqual(2)
        expect(plan.bootstrap).not.toContain('Claude Code')
    })

    test('prefers metadata.name over a stale summary for the voice session header', () => {
        const session = {
            id: 'sess-named',
            metadata: {
                path: '/proj',
                name: 'Renamed triage peer',
                summary: { text: 'issue-triage-#54' }
            }
        } as Session

        const plan = buildSessionVoiceContextPlan(session, [], 'Codex')

        expect(plan.bootstrap).toContain('Renamed triage peer')
        expect(plan.bootstrap).not.toContain('issue-triage-#54')
    })

    test('uses metadata.name alone when no summary exists', () => {
        const session = {
            id: 'sess-name-only',
            metadata: {
                path: '/proj',
                name: 'spawned-peer'
            }
        } as Session

        const plan = buildSessionVoiceContextPlan(session, [], 'Codex')

        expect(plan.bootstrap).toContain('spawned-peer')
    })

    test('handles missing session', () => {
        const plan = buildSessionVoiceContextPlan(null, [], 'Claude')
        expect(plan.bootstrap).toBe('Session not available')
        expect(plan.streamChunks).toEqual([])
    })

    test.each(['a', '🙂'])('reports shortened older context with %s text when bootstrap fits', (character) => {
        const plan = buildSessionVoiceContextPlan(makeSession('sess-large-history'), [
            makeMessage(1, character.repeat(VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES) + 'older-message-end'),
            makeMessage(2, 'recent one'),
            makeMessage(3, 'recent two')
        ], 'Codex')

        expect(plan.bootstrap).toContain('recent one')
        expect(plan.bootstrap).toContain('recent two')
        expect(plan.streamChunks).toHaveLength(1)
        expect(utf8ByteLength(plan.streamChunks[0])).toBeLessThanOrEqual(VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES)
        expect(plan.streamChunks[0]).not.toContain('older-message-end')
        expect(plan.truncated).toBe(true)
        expect(plan.notice).toContain('Some session context was shortened')
    })

    test('keeps complete older messages across chunks without a truncation notice', () => {
        const older = Array.from({ length: 3 }, (_, index) => `history-${index}: ${'a'.repeat(5_000)}`)
        const plan = buildSessionVoiceContextPlan(makeSession('sess-complete-history'), [
            ...older.map((text, index) => makeMessage(index + 1, text)),
            makeMessage(4, 'recent one'),
            makeMessage(5, 'recent two')
        ], 'Codex')

        expect(plan.streamChunks).toHaveLength(3)
        for (const text of older) expect(plan.streamChunks.join('\n')).toContain(text)
        for (const chunk of plan.streamChunks) expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES)
        expect(plan.truncated).toBe(false)
        expect(plan.notice).not.toContain('shortened')
    })

    test('reports a shortened bootstrap even without older messages', () => {
        const plan = buildSessionVoiceContextPlan(makeSession('sess-large-bootstrap'), [
            makeMessage(1, '🙂'.repeat(ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES))
        ], 'Codex')

        expect(utf8ByteLength(plan.bootstrap)).toBeLessThanOrEqual(ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
        expect(plan.streamChunks).toEqual([])
        expect(plan.truncated).toBe(true)
        expect(plan.notice).toContain('Some session context was shortened')
    })
})
