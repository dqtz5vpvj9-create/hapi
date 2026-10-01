import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { CliSocketWithData } from '../socket/socketTypes'
import type { SyncEvent } from '@hapi/protocol/types'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import { withNativeQueuePage } from '../sync/nativeQueuePage'
import { SyncEngine } from '../sync/syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'

function fixture() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('native-queue', { capabilities: { concurrentClients: true } }, null, 'default')
    const handlers = new Map<string, (data: unknown) => void>()
    const events: SyncEvent[] = []
    const socket = { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler),
        to: () => ({ emit() {} }) } as unknown as CliSocketWithData
    registerSessionHandlers(socket, { store, resolveSessionAccess: () => ({ ok: true, value: session }),
        emitAccessError() {}, onWebappEvent: event => events.push(event) })
    const emit = (name: string, data: object) => handlers.get(name)?.({ sid: session.id, ...data })
    const snapshot = (messages: Array<{ localId: string; text: string }>) => emit('native-queue-snapshot', { messages })
    return { store, session, events, emit, snapshot }
}
const user = (sentFrom: string, text = 'same text') => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom } })
const page: MessagesResponse = { messages: [], page: { direction: 'latest', limit: 20, reset: false,
    hasMore: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, epoch: 1,
    snapshotHeadAt: 123, snapshotHeadSeq: 10 } }

describe('native queue lifecycle across Hub clients', () => {
    it('surfaces failed native reads without consuming pending input', async () => {
        const f = fixture()
        const engine = new SyncEngine(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            f.store.messages.addMessage(f.session.id, user('web'), 'hapi-unknown')
            f.store.messages.markMessagesIndeterminate(f.session.id, ['hapi-unknown'])
            const gateway = (engine as unknown as {
                rpcGateway: { readCodexHistory: () => Promise<unknown> }
            }).rpcGateway
            gateway.readCodexHistory = async () => ({ error: 'Native history temporarily unavailable' })

            for (const query of [{ limit: 20 }, { operation: 'outline' }, { operation: 'dependencies' }]) {
                await expect(engine.readCodexHistory(f.session.id, query)).rejects.toThrow('Native history temporarily unavailable')
                expect(f.store.messages.lookupQueuedMessage(f.session.id, 'hapi-unknown').status).toBe('indeterminate')
                expect(f.store.messages.getUninvokedLocalMessages(f.session.id)).toHaveLength(1)
            }
        } finally { engine.stop(); f.store.close() }
    })

    it('retires only absent native-origin mirrors; refresh retains genuine HAPI uncertain and scheduled sends', () => {
        const f = fixture()
        try {
            f.snapshot([{ localId: 'removed-native', text: 'same text' }, { localId: 'pending-native', text: 'pending' }])
            f.store.messages.setMessagesDeliveryState(f.session.id, ['removed-native'], 'indeterminate')
            f.store.messages.addMessage(f.session.id, user('web'), 'hapi-unknown')
            f.store.messages.setMessagesDeliveryState(f.session.id, ['hapi-unknown'], 'indeterminate')
            f.store.messages.addMessage(f.session.id, user('web'), 'hapi-pending')
            f.store.messages.addMessage(f.session.id, user('web'), 'scheduled', Date.now() + 60_000)
            f.store.messages.addMessage(f.session.id, { ...user('cli'), meta: { sentFrom: 'cli' } }, 'legacy-without-provenance')
            // Mirroring a Web send must retain Web provenance, even after native editing.
            f.emit('native-queue-message', { localId: 'hapi-unknown', text: 'edited' })
            f.snapshot([{ localId: 'pending-native', text: 'edited pending' }])
            const rows = f.store.messages.getAllMessages(f.session.id)
            expect(rows.map(row => row.localId)).not.toContain('removed-native')
            expect(rows.map(row => row.localId)).toEqual(['pending-native', 'hapi-unknown', 'hapi-pending', 'scheduled', 'legacy-without-provenance'])
            expect(f.events.some(event => event.type === 'messages-consumed' || event.type === 'message-cancelled')).toBe(false)
            // A new browser/device loads the same pinned inputs, without altering native cursors.
            for (let client = 0; client < 2; client++) {
                const result = withNativeQueuePage(f.store, f.session.id, page)
                expect(result.page).toEqual(page.page)
                expect(result.messages.map(row => row.localId)).toEqual(rows.map(row => row.localId))
                expect(result.messages.every(row => row.seq === null)).toBe(true)
                expect(result.messages.find(row => row.localId === 'hapi-unknown')).toMatchObject({ invokedAt: null, deliveryState: 'indeterminate' })
            }
            // Reconnect with an empty native snapshot retires pending native input alone.
            f.snapshot([])
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'pending-native').status).toBe('absent')
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'hapi-unknown').status).toBe('indeterminate')
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'hapi-pending').status).toBe('queued')
        } finally { f.store.close() }
    })

    it('commits an external native user item after an early ACK and preserves identity/time on replay', () => {
        const f = fixture()
        try {
            f.emit('messages-consumed', { localIds: ['native-accepted'] }) // no Hub row yet
            f.emit('message', { localId: 'native-accepted', message: user('cli') })
            const accepted = f.store.messages.getAllMessages(f.session.id)[0]!
            expect(accepted.invokedAt).toBeNumber()
            expect(f.events.at(-1)).toMatchObject({ type: 'message-received', message: { localId: 'native-accepted', invokedAt: accepted.invokedAt } })
            f.snapshot([])
            f.emit('messages-consumed', { localIds: ['native-accepted'] })
            f.emit('message', { localId: 'native-accepted', message: user('cli') })
            expect(f.store.messages.getAllMessages(f.session.id)).toEqual([accepted])
        } finally { f.store.close() }
    })

    it('matches native acceptance by ID, keeps the Web attachment/source, and ignores malformed snapshots', () => {
        const f = fixture()
        try {
            const original = { ...user('web'), content: { type: 'text', text: 'same text', attachments: [{ name: 'image.png' }] } }
            f.store.messages.addMessage(f.session.id, original, 'accepted-hapi')
            f.store.messages.addMessage(f.session.id, user('web'), 'different-id-same-text')
            f.snapshot([{ localId: 'accepted-hapi', text: 'same text' }])
            f.emit('message', { localId: 'accepted-hapi', message: user('cli') })
            const accepted = f.store.messages.getAllMessages(f.session.id)[0]!
            expect(accepted.content).toEqual(original)
            f.snapshot([])
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'accepted-hapi').status).toBe('invoked')
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'different-id-same-text').status).toBe('queued')
            f.snapshot([{ localId: 'native-still-pending', text: 'pending' }])
            f.emit('native-queue-snapshot', { messages: [{}] })
            expect(f.store.messages.lookupQueuedMessage(f.session.id, 'native-still-pending').status).toBe('queued')
        } finally { f.store.close() }
    })
})
