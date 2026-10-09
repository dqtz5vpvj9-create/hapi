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
    ])('opens %s in the source session document viewer', path => {
        if (path.startsWith('C:')) mocks.workspacePath = String.raw`C:\Users\chris\project`
        renderCitation(path)
        fireEvent.click(screen.getByRole('link', { name: path.split(/[\\/]/).at(-1)! }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            params: { sessionId: 'session-1' }, search: { path: encodeBase64(path), origin: 'chat' },
        }))
    })

    it.each(['/outside/secret.pdf', '../secret.pdf', 'javascript:alert(1)', 'https://example.com/a.pdf'])('keeps unauthorized or non-file target %s inert', path => {
        renderCitation(path)
        expect(screen.queryByRole('link')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
        expect(mocks.navigate).not.toHaveBeenCalled()
    })
})

describe('chat file anchors', () => {
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
