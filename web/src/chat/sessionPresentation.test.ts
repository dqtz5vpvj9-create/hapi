import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { clearSessionPresentations, getSessionPresentation, retainSessionPresentation, RECENT_SESSION_PRESENTATIONS } from './sessionPresentation'

function transcript(text = 'The current answer'): DecryptedMessage[] {
    return [{ id: 'answer', localId: null, seq: 1, createdAt: 1000, invokedAt: 1000,
        content: { role: 'agent', content: { type: 'codex', data: {
            type: 'message', message: text, streamSnapshot: true,
            nativeExecution: { threadId: 'thread', turnId: 'turn', itemId: 'answer', phase: 'final_answer' },
        } } } } as DecryptedMessage]
}

describe('recent native session presentations', () => {
    it('keeps all mounted panes while evicting idle chats, then releases the closed pane', () => {
        const api = {} as ApiClient
        const mounted = Array.from({ length: 7 }, (_, i) => {
            const id = `visible-${i}`, value = getSessionPresentation(api, id)
            return { id, value, release: retainSessionPresentation(api, id, value) }
        })
        for (let i = 0; i < 15; i++) getSessionPresentation(api, `background-${i}`)
        for (const { id, value } of mounted) expect(getSessionPresentation(api, id)).toBe(value)
        mounted[0].release()
        for (let i = 0; i < 10; i++) getSessionPresentation(api, `new-background-${i}`)
        expect(getSessionPresentation(api, mounted[0].id)).not.toBe(mounted[0].value)
        for (const { id, value, release } of mounted.slice(1)) { expect(getSessionPresentation(api, id)).toBe(value); release() }
    })
    it('reuses prepared content after visiting B, but applies authoritative updates and epoch replacement', () => {
        const api = {} as ApiClient
        const rows = transcript()
        const a = getSessionPresentation(api, 'A')
        const before = a.read(rows, null, 1)
        a.nativeProjection.update(before.reconciled.blocks, before.normalizedMessages)
        a.nativeProjection.disclosureState.set('answer', true)
        getSessionPresentation(api, 'B').read(transcript('B'), null, 1)
        const returned = getSessionPresentation(api, 'A')
        expect(returned.read(rows, null, 1)).toBe(before)
        expect(returned.nativeProjection.disclosureState.get('answer')).toBe(true)

        const updated = returned.read(transcript('Revised while away'), null, 1)
        expect(updated.reconciled.blocks[0]).toMatchObject({ kind: 'agent-text', text: 'Revised while away' })
        expect(updated.reconciled.blocks[0]).not.toBe(before.reconciled.blocks[0])
        returned.read(rows, null, 2)
        expect(returned.nativeProjection.disclosureState.size).toBe(0)
    })

    it('evicts the least recently visited session and isolates authentication lifetimes', () => {
        const api = {} as ApiClient, otherApi = {} as ApiClient
        const a = getSessionPresentation(api, 'A')
        const b = getSessionPresentation(api, 'B')
        for (let i = 2; i < RECENT_SESSION_PRESENTATIONS; i++) getSessionPresentation(api, String(i))
        expect(getSessionPresentation(api, 'A')).toBe(a)
        getSessionPresentation(api, 'new-session')
        expect(getSessionPresentation(api, 'A')).toBe(a)
        expect(getSessionPresentation(api, 'B')).not.toBe(b)
        expect(getSessionPresentation(otherApi, 'A')).not.toBe(a)
        clearSessionPresentations(api)
        expect(getSessionPresentation(api, 'A')).not.toBe(a)
    })
})
