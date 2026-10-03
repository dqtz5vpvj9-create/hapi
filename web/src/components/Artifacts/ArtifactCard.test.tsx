import { Blob } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import type { ApiClient } from '@/api/client'
import { ArtifactCard } from './ArtifactCard'
import { ContentParts } from './ContentParts'

function mount(children: React.ReactNode, read = vi.fn(async () => new Blob(['<button>Click</button>'], { type: 'text/html' }))) {
    localStorage.setItem('hapi-lang', 'en')
    const value: HappyChatContextValue = { api: { getArtifactBlob: read } as unknown as ApiClient, sessionId: 'session', metadata: null,
        terminalToolDisplayMode: 'compact', disabled: false, showSessionSummaryInChat: false, onRefresh: () => {},
        hasMoreMessages: false, isSyncingTail: false, isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => 'loaded' }
    render(<I18nProvider><HappyChatProvider value={value}>{children}</HappyChatProvider></I18nProvider>)
    return read
}

describe('artifact cards', () => {
    it('loads HTML only on user request and isolates its scripts from HAPI', async () => {
        const read = mount(<ArtifactCard artifact={{ id: 'html', fileName: 'report.html', mimeType: 'text/html' }} />)
        expect(read).not.toHaveBeenCalled()
        fireEvent.click(screen.getByText('Open preview / prepare download'))
        const frame = await screen.findByTitle('report.html')
        expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
        expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
        expect(read).toHaveBeenCalledWith('session', 'html', expect.any(AbortSignal))
        expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument()
    })
    it('keeps unavailable resource cards and retries explicitly', async () => {
        const read = vi.fn().mockRejectedValueOnce(new Error('The original file is no longer available')).mockResolvedValue(new Blob(['text'], { type: 'text/plain' }))
        mount(<ArtifactCard artifact={{ id: 'file', fileName: 'notes.txt', mimeType: 'text/plain' }} />, read)
        fireEvent.click(screen.getByText('Open preview / prepare download'))
        expect(await screen.findByRole('alert')).toHaveTextContent('The original file is no longer available')
        expect(screen.getByText('notes.txt')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Retry'))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        expect(read).toHaveBeenCalledTimes(2)
    })
    it('renders text and media in their original order without raw URLs or base64', () => {
        mount(<ContentParts parts={[{ type: 'text', text: 'Before the image' }, { type: 'artifact', artifact: { id: 'image', fileName: 'sample.png', mimeType: 'image/png' } }, { type: 'text', text: 'After the image' }]} />,
            vi.fn(async () => new Blob(['png'], { type: 'image/png' })))
        const before = screen.getByText('Before the image')
        const image = screen.getByText('sample.png')
        const after = screen.getByText('After the image')
        expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})
