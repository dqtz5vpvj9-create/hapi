import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReactMarkdown from 'react-markdown'
import { defaultComponents, MARKDOWN_PLUGINS, markdownUrlTransform, UriConfirmProvider } from '@/components/assistant-ui/markdown-text'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    workspacePath: '/android/paper_repo/mobile-agent-submission-20260911',
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useRouter: () => undefined,
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ sessionId: 'session-1', metadata: { path: mocks.workspacePath } }),
}))

const AnchorComponent = (defaultComponents as Record<string, unknown>).a as React.ComponentType<
    React.ComponentPropsWithoutRef<'a'>
>

function renderFileAnchor(filePath: string) {
    return render(
        <I18nProvider>
            <UriConfirmProvider>
                <AnchorComponent href={`hapi-file:${encodeURIComponent(filePath)}`}>
                    {filePath}
                </AnchorComponent>
            </UriConfirmProvider>
        </I18nProvider>
    )
}

beforeEach(() => {
    vi.unstubAllEnvs()
    mocks.navigate.mockReset()
    mocks.workspacePath = '/android/paper_repo/mobile-agent-submission-20260911'
})

describe('Codex file citation navigation', () => {
    function renderCitation(path: string) {
        return render(<I18nProvider><UriConfirmProvider>
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={{ a: AnchorComponent }} urlTransform={markdownUrlTransform}>
                {`:codex-file-citation{path="${path}" purpose="output"}`}
            </ReactMarkdown>
        </UriConfirmProvider></I18nProvider>)
    }

    it.each([
        '/android/paper_repo/mobile-agent-submission-20260911/workreport-20261009/Choreo_revision_workreport_20261009_v19.pptx',
        '/android/paper_repo/mobile-agent-submission-20260911/中文 文件#1%20.md',
        String.raw`C:\Users\chris\project\中文 文件.pptx`,
        String.raw`C:\Users\chris\project\中文 #1%20.md`,
    ])('opens %s in the source session document viewer', path => {
        if (path.startsWith('C:')) mocks.workspacePath = String.raw`C:\Users\chris\project`
        renderCitation(path)
        fireEvent.click(screen.getByRole('link', { name: path.split(/[\\/]/).at(-1)! }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            params: { sessionId: 'session-1' }, search: { path: encodeBase64(path), origin: 'chat' },
        }))
    })

    it.each(['javascript:alert(1)', 'https://example.com/a.pdf'])('keeps unauthorized or non-file target %s inert', path => {
        renderCitation(path)
        expect(screen.queryByRole('link')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
        expect(mocks.navigate).not.toHaveBeenCalled()
    })
})

describe('chat file anchors', () => {
    function renderMarkdown(content: string) {
        return render(<I18nProvider><UriConfirmProvider>
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={{ a: AnchorComponent }} urlTransform={markdownUrlTransform}>
                {content}
            </ReactMarkdown>
        </UriConfirmProvider></I18nProvider>)
    }

    it.each([
        ['build/image.tar.gz', 'build/image.tar.gz'],
        ['/android/paper_repo/mobile-agent-submission-20260911/build/image.tar.gz', 'build/image.tar.gz'],
        ['build/中文%20文件%231%2520.unknown', 'build/中文 文件#1%20.unknown'],
        [String.raw`C:\Users\chris\project\build\image.custom`, 'build/image.custom'],
        [String.raw`C:\Users\chris\project\build\foo%23bar%2520.custom`, 'build/foo#bar%20.custom'],
    ])('opens unsupported explicit %s in the file manager', (path, target) => {
        if (path.startsWith('C:')) mocks.workspacePath = String.raw`C:\Users\chris\project`
        renderMarkdown(`[archive](${path})`)
        const link = screen.getByRole('link', { name: 'archive' })
        const url = new URL(link.getAttribute('href')!, 'https://hapi.example')
        expect(url.pathname).toBe('/sessions/session-1/files')
        expect(url.searchParams.get('tab')).toBe('directories')
        expect(url.searchParams.get('target')).toBe(target)
        expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
        fireEvent.click(link)
        expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId/files', params: { sessionId: 'session-1' },
            search: { tab: 'directories', target }, state: expect.any(Function), resetScroll: false })
    })

    it('keeps the base URL in the copyable/new-tab href and gives repeated clicks distinct reveal state', () => {
        vi.stubEnv('BASE_URL', '/hapi/')
        renderMarkdown('[archive](build/image.tar.gz)')
        const link = screen.getByRole('link', { name: 'archive' })
        expect(link.getAttribute('href')).toBe('/hapi/sessions/session-1/files?tab=directories&target=build%2Fimage.tar.gz')
        fireEvent.click(link)
        fireEvent.click(link)
        const states = mocks.navigate.mock.calls.map(([options]) => options.state({}))
        expect(states[0].fileManagerReveal).not.toBe(states[1].fileManagerReveal)
    })

    it('can reveal files on an insecure LAN origin without crypto.randomUUID', () => {
        const crypto = globalThis.crypto
        vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
        try {
            renderMarkdown('[archive](build/image.tar.gz)')
            fireEvent.click(screen.getByRole('link', { name: 'archive' }))
            expect(mocks.navigate.mock.calls[0]![0].state({}).fileManagerReveal).toEqual(expect.any(String))
        } finally { vi.unstubAllGlobals() }
    })

    it('does not broaden bare prose or inline-code autolinking', () => {
        renderMarkdown('build/image.tar.gz and `build/image.custom` and example.org')
        expect(screen.queryByRole('link')).toBeNull()
    })

    it.each(['/outside/image.tar.gz', '../image.tar.gz', 'javascript:alert(1)', 'file:///tmp/image.tar.gz'])('does not navigate unsafe %s', path => {
        renderMarkdown(`[archive](${path})`)
        fireEvent.click(screen.getByText('archive'))
        expect(mocks.navigate).not.toHaveBeenCalled()
    })

    it.each(['src/main.ts', 'slides/deck.pptx', 'images/photo.png'])('retains the existing preview for %s', path => {
        renderMarkdown(`[supported](${path})`)
        fireEvent.click(screen.getByRole('link', { name: 'supported' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/sessions/$sessionId/file', search: { path: encodeBase64(path), origin: 'chat' } }))
    })

    it('marks file previews as originating from chat for deterministic back navigation', () => {
        const filePath = 'docs/guide.md'
        renderFileAnchor(filePath)
        const link = screen.getByRole('link', { name: filePath })
        const href = new URL(link.getAttribute('href')!, 'https://hapi.example')

        expect(href.pathname).toBe('/sessions/session-1/file')
        expect(href.searchParams.get('path')).toBe(encodeBase64(filePath))
        expect(href.searchParams.get('origin')).toBe('chat')

        fireEvent.click(link)

        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                origin: 'chat',
            },
            resetScroll: false,
        })
    })
})
