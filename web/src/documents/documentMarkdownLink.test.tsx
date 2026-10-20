import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UriConfirmProvider } from '@/components/assistant-ui/markdown-text'
import { I18nProvider } from '@/lib/i18n-context'
import { DocumentMarkdownAnchor, DocumentMarkdownLinkProvider, resolveDocumentMarkdownHref } from './documentMarkdownLink'

const SOURCE = '/data/review/EuroSys/README.md'

describe('resolveDocumentMarkdownHref', () => {
    it('resolves a relative link against the document path', () => {
        expect(resolveDocumentMarkdownHref('WHIZ/导读.md', SOURCE))
            .toEqual({ kind: 'file', path: '/data/review/EuroSys/WHIZ/导读.md' })
    })

    it('resolves parent segments against the document path', () => {
        expect(resolveDocumentMarkdownHref('../SOP.md', SOURCE))
            .toEqual({ kind: 'file', path: '/data/review/SOP.md' })
    })

    it('keeps fragments alongside the resolved file', () => {
        expect(resolveDocumentMarkdownHref('WHIZ/导读.md#结论', SOURCE))
            .toEqual({ kind: 'file', path: '/data/review/EuroSys/WHIZ/导读.md', fragment: '#%E7%BB%93%E8%AE%BA' })
    })

    it('resolves Windows relative links against a Windows document path', () => {
        expect(resolveDocumentMarkdownHref('notes\\导读.md', String.raw`C:\review\README.md`))
            .toEqual({ kind: 'file', path: String.raw`C:\review\notes\导读.md` })
    })

    it('passes absolute POSIX paths through', () => {
        expect(resolveDocumentMarkdownHref('/data/shared/SOP.md', SOURCE))
            .toEqual({ kind: 'file', path: '/data/shared/SOP.md' })
    })

    it('classifies http(s) links as external', () => {
        expect(resolveDocumentMarkdownHref('https://example.com/a', SOURCE))
            .toEqual({ kind: 'external', url: 'https://example.com/a' })
    })

    it('leaves fragments and app routes to the generic anchor policy', () => {
        expect(resolveDocumentMarkdownHref('#结论', SOURCE)).toBeUndefined()
        expect(resolveDocumentMarkdownHref('/settings', SOURCE)).toBeUndefined()
        expect(resolveDocumentMarkdownHref('/sessions/abc', SOURCE)).toBeUndefined()
    })

    it('does not resolve a relative link without a document path', () => {
        expect(resolveDocumentMarkdownHref('WHIZ/导读.md')).toBeUndefined()
    })

    it('leaves directory links to the generic anchor policy', () => {
        expect(resolveDocumentMarkdownHref('WHIZ/', SOURCE)).toBeUndefined()
    })

    it('decodes autolinked bare paths before resolving', () => {
        const encoded = `hapi-file:${encodeURIComponent('../SOP.md')}`
        expect(resolveDocumentMarkdownHref(encoded, SOURCE)).toEqual({ kind: 'file', path: '/data/review/SOP.md' })
        expect(resolveDocumentMarkdownHref('hapi-file:', SOURCE)).toBeUndefined()
    })

    it('rejects script and data URLs', () => {
        expect(resolveDocumentMarkdownHref('javascript:alert(1)', SOURCE)).toBeUndefined()
        expect(resolveDocumentMarkdownHref('data:text/html,<h1>x</h1>', SOURCE)).toBeUndefined()
    })
})

function renderAnchor(href: string, options: { sourcePath?: string; onOpenFile?: (path: string) => void } = {}) {
    const onOpenFile = options.onOpenFile ?? vi.fn()
    const sourcePath = 'sourcePath' in options ? options.sourcePath : SOURCE
    render(
        <I18nProvider>
            <UriConfirmProvider>
                <DocumentMarkdownLinkProvider value={{ sessionId: 'session-1', sourcePath, onOpenFile }}>
                    <DocumentMarkdownAnchor href={href}>WHIZ 阅读导读</DocumentMarkdownAnchor>
                </DocumentMarkdownLinkProvider>
            </UriConfirmProvider>
        </I18nProvider>,
    )
    return onOpenFile
}

describe('DocumentMarkdownAnchor', () => {
    beforeEach(() => { cleanup() })

    it('renders a relative document link as a navigable anchor', () => {
        renderAnchor('WHIZ/导读.md')
        const link = screen.getByRole('link', { name: 'WHIZ 阅读导读' })
        expect(link.getAttribute('href')).toContain('/sessions/session-1/file?')
        expect(link.getAttribute('href')).not.toContain('#')
    })

    it('opens the resolved file on a plain left click', () => {
        const onOpenFile = renderAnchor('WHIZ/导读.md')
        fireEvent.click(screen.getByRole('link', { name: 'WHIZ 阅读导读' }))
        expect(onOpenFile).toHaveBeenCalledWith('/data/review/EuroSys/WHIZ/导读.md')
    })

    it('keeps modifier clicks for the browser', () => {
        const onOpenFile = renderAnchor('WHIZ/导读.md')
        const link = screen.getByRole('link', { name: 'WHIZ 阅读导读' })
        // jsdom cannot follow the route href; cancel the default action at the
        // target so the test observes only the component's own predicate.
        link.addEventListener('click', event => event.preventDefault())
        fireEvent.click(link, { ctrlKey: true })
        expect(onOpenFile).not.toHaveBeenCalled()
    })

    it('delegates external links to the generic anchor policy', () => {
        renderAnchor('https://example.com/review')
        const link = screen.getByRole('link', { name: 'WHIZ 阅读导读' })
        expect(link).toHaveAttribute('href', 'https://example.com/review')
    })

    it('falls back to inert text when the document has no path', () => {
        renderAnchor('WHIZ/导读.md', { sourcePath: undefined })
        // The generic standalone anchor renders unresolved relative links as an
        // inert span instead of painting a dead link.
        expect(document.querySelector('a.aui-md-a')).toBeNull()
        expect(document.querySelector('.aui-md-a-inert')?.textContent).toBe('WHIZ 阅读导读')
    })
})
