import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { ArtifactCard } from '../src/components/Artifacts/ArtifactCard'
import { MessageAttachments } from '../src/components/AssistantChat/messages/MessageAttachments'
import type { ApiClient } from '../src/api/client'

const pending = new Map<string, (blob: Blob) => void>()
const image = (height: number) => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}"><rect width="640" height="${height}" fill="#90b9ec"/></svg>`], { type: 'image/svg+xml' })
Object.assign(window, { pendingMediaCount: () => pending.size, releaseMedia: (id: string) => pending.get(id)?.(id === 'document' ? new Blob(['Preview content\n'.repeat(500)], { type: 'text/plain' }) : image(id === 'portrait' ? 1600 : 120)) })
const value: HappyChatContextValue = {
    api: { getArtifactBlob: (_session: string, id: string) => new Promise<Blob>(resolve => pending.set(id, resolve)) } as unknown as ApiClient,
    sessionId: 'media-layout', metadata: null, terminalToolDisplayMode: 'compact', showSessionSummaryInChat: false, disabled: false,
    onRefresh: () => {}, hasMoreMessages: false, isSyncingTail: false, isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => 'loaded',
}
ReactDOM.createRoot(document.getElementById('root')!).render(<I18nProvider><HappyChatProvider value={value}>
    <main style={{ maxWidth: 680, padding: 16 }}>
        <p>Read the attachments without losing this conversation.</p>
        {['portrait', 'landscape'].map(id => <section key={id} data-test-media={id}><ArtifactCard artifact={{ id, fileName: `${id}.svg`, mimeType: 'image/svg+xml' }} /></section>)}
        <p data-test-anchor>Continue reading here.</p>
        <section data-test-media="document"><ArtifactCard artifact={{ id: 'document', fileName: 'notes.txt', mimeType: 'text/plain' }} /></section>
        <p data-test-after-document>Text after the document.</p>
        <MessageAttachments attachments={[{ id: 'sent', filename: 'sent.svg', mimeType: 'image/svg+xml', size: 0, path: '', previewUrl: '/delayed-attachment.svg' }]} />
        <p data-test-after-attachment>Text after the sent image.</p>
    </main>
</HappyChatProvider></I18nProvider>)
