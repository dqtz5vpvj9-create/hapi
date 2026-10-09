// Production controls with deterministic transport failures. No real agent/model is launched.
import React, { useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider, useToast } from '../src/lib/toast-context'
import { ScratchlistDrawer } from '../src/components/AssistantChat/ScratchlistPanel'
import { QueuedMessagesBar } from '../src/components/AssistantChat/QueuedMessagesBar'
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog'
import { createForkNavigator } from '../src/lib/fork-navigation'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { ingestIncomingMessages } from '../src/lib/message-window-store'
import type { ApiClient } from '../src/api/client'
import type { Session, DecryptedMessage } from '../src/types/api'

const id = 'exceptional-fixture'
const initial: DecryptedMessage = {
    id: 'server-note', localId: 'local-note', seq: 1, createdAt: 1000, invokedAt: null,
    content: { role: 'user', content: { type: 'text', text: 'Change the approach' } },
} as DecryptedMessage
const harness = { sends: 0, forks: 0, navigations: 0, steers: 0, reads: 0, cleanupFails: true, steerFails: false, navigationFails: true }
Object.assign(window, { exceptional: harness })
ingestIncomingMessages(id, [initial])
let consumed = false
const api = {
    steerMessage: async () => {
        harness.steers++
        await new Promise(resolve => setTimeout(resolve, 150))
        if (harness.steerFails) throw new TypeError('Offline')
        consumed = true
        return { status: 'steered', localId: 'local-note' }
    },
    getMessages: async () => {
        harness.reads++
        const messages = [{ ...initial, invokedAt: consumed ? 2000 : null, steered: consumed }]
        return { messages, page: { direction: 'latest', limit: 200, epoch: 1, reset: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: consumed ? 2000 : 1000, snapshotHeadSeq: 1, hasMore: false } }
    },
} as unknown as ApiClient
function App() {
    const [entries, setEntries] = useState([{ id: 'saved', text: 'Keep this plan safe', createdAt: 1000 }])
    const [drawerOpen, setDrawerOpen] = useState(true)
    const [forkOpen, setForkOpen] = useState(false)
    const [destination, setDestination] = useState('original')
    const { toasts } = useToast()
    const fork = useMemo(() => createForkNavigator(async () => {
        harness.forks++
        await new Promise(resolve => setTimeout(resolve, 150))
        return { sessionId: 'forked-session' }
    }, async child => {
        harness.navigations++
        if (harness.navigationFails) throw new Error('Navigation failed; retry opens the existing fork')
        setDestination(child)
    }), [])
    const session = { id, active: true, thinking: true, metadata: { flavor: 'pi', path: '/fixture' } } as Session
    const runtime = useHappyRuntime({ session, blocks: [], messagesVersion: 1, isSending: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}><main className="mx-auto max-w-xl p-4 space-y-5">
        <h1>Exceptional agent workflows</h1>
        <button onClick={() => setForkOpen(true)}>Fork conversation</button>
        <p data-testid="destination">{destination}</p>
        <ConfirmDialog isOpen={forkOpen} onClose={() => setForkOpen(false)} title="Create a fork" description="The original session stays unchanged." confirmLabel="Create fork" confirmingLabel="Creating fork…" isPending={false} onConfirm={() => fork('boundary')} />
        <button onClick={() => setDrawerOpen(open => !open)}>Toggle scratchlist</button>
        {drawerOpen ? <ScratchlistDrawer entries={entries} sessionId={id} api={api}
            onMove={() => {}} onPromoteToComposer={async () => { throw new Error('Attachment unavailable') }}
            onPromoteToQueue={async () => { harness.sends++; return true }}
            onDelete={async entryId => { if (harness.cleanupFails) throw new Error('Offline'); setEntries(rows => rows.filter(row => row.id !== entryId)) }}
            onQueueComplete={() => setDrawerOpen(false)} /> : null}
        <QueuedMessagesBar sessionId={id} api={api} pendingSchedule={null} pendingScheduleRevision={0} canSteer />
        {toasts.map(toast => <p key={toast.id} role="alert">{toast.title}: {toast.body}</p>)}
    </main></AssistantRuntimeProvider>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><ToastProvider><App /></ToastProvider></I18nProvider></QueryClientProvider>)
