import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { SessionFile } from './file'

const mocks = vi.hoisted(() => ({
    diff: vi.fn(), read: vi.fn(),
    highlight: vi.fn((code: string) => ({ type: 'root', children: [{ type: 'element', tagName: 'span', properties: { className: ['probe-highlighted'] }, children: [{ type: 'text', value: code }] }] })),
}))
vi.mock('shiki/core', () => ({ createHighlighterCore: async () => ({ getLoadedLanguages: () => ['typescript', 'markdown'], codeToHast: mocks.highlight }) }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { getGitDiffFile: mocks.diff, readSessionFile: mocks.read } }) }))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }) }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: (props: { content: string }) => <div data-testid="markdown-preview">{props.content}</div> }))

const patch = 'diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-old\n+DIFF-MARKER\n'
const source = 'export const CURRENT_SOURCE = "A";'
const response = (text: string) => ({ success: true, content: encodeBase64(text), size: text.length, modified: 1790000000000 })
const charBudgetSource = (length: number) => `${'a'.repeat(127)}\n`.repeat(512).slice(0, length)
const longComment = (length: number) => `//${'a'.repeat(length - 2)}`
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
function setup(initial = { sessionId: 'A', path: 'source.ts', staged: false as boolean | undefined }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (props: typeof initial) => <QueryClientProvider client={client}><I18nProvider><SessionFile sessionId={props.sessionId} search={{ path: encodeBase64(props.path), staged: props.staged }} onBack={() => {}} /></I18nProvider></QueryClientProvider>
    const result = render(view(initial))
    return { ...result, client, rerenderFile: (props: typeof initial) => result.rerender(view(props)) }
}
beforeEach(() => {
    mocks.highlight.mockClear(); mocks.diff.mockReset().mockResolvedValue({ success: true, stdout: patch }); mocks.read.mockReset().mockResolvedValue(response(source))
    localStorage.clear(); sessionStorage.clear()
})

describe('SessionFile source highlighting lifetime', () => {
    it('keeps prefetched source cached without highlighting while a diff is visible', async () => {
        const { client } = setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        await waitFor(() => expect(client.getQueryData(queryKeys.sessionFile('A', 'source.ts'))).toEqual(response(source)))
        await settle()
        expect(mocks.read).toHaveBeenCalledWith('A', 'source.ts')
        expect(mocks.highlight).not.toHaveBeenCalled()
        expect(screen.queryByRole('code')).not.toBeInTheDocument()
    })

    it('shows current plaintext immediately on File, then completes its highlight', async () => {
        setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(screen.getByRole('code')).toHaveTextContent(source)
        expect(document.querySelector('.probe-highlighted')).toBeNull()
        await waitFor(() => expect(document.querySelector('.probe-highlighted')).toHaveTextContent(source))
        expect(mocks.highlight).toHaveBeenCalledWith(source, expect.anything())
    })

    it.each(['diff', 'close'])('cancels a pending source highlight when leaving for %s', async destination => {
        const view = setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(screen.getByRole('code')).toHaveTextContent(source)
        if (destination === 'diff') fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
        else view.unmount()
        await settle()
        expect(mocks.highlight).not.toHaveBeenCalled()
    })

    it('replaces old highlighted content immediately when the same file query refreshes', async () => {
        const { client } = setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        await waitFor(() => expect(document.querySelector('.probe-highlighted')).toHaveTextContent(source))
        const next = 'export const CURRENT_SOURCE = "B-NEW";'
        await act(async () => { client.setQueryData(queryKeys.sessionFile('A', 'source.ts'), response(next)); await new Promise(resolve => setTimeout(resolve, 0)) })
        expect(screen.getByRole('code')).toHaveTextContent(next)
        expect(screen.getByRole('code')).not.toHaveTextContent('"A"')
        expect(document.querySelector('.probe-highlighted')).toBeNull()
        await waitFor(() => expect(document.querySelector('.probe-highlighted')).toHaveTextContent(next))
    })

    it('does not render a late A response in B source', async () => {
        let release!: (value: ReturnType<typeof response>) => void
        mocks.read.mockImplementation((id: string) => id === 'A' ? new Promise(resolve => { release = resolve }) : Promise.resolve(response('export const B_ONLY = true;')))
        const view = setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        view.rerenderFile({ sessionId: 'B', path: 'source.ts', staged: false })
        await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('B', 'source.ts'))
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        await waitFor(() => expect(screen.getByRole('code')).toHaveTextContent('B_ONLY'))
        await act(async () => { release(response('export const A_LATE = true;')) })
        await settle()
        expect(screen.getByRole('code')).toHaveTextContent('B_ONLY')
        expect(screen.getByRole('code')).not.toHaveTextContent('A_LATE')
        expect(mocks.highlight.mock.calls.every(([text]) => !text.includes('A_LATE'))).toBe(true)
    })

    it('does not highlight Markdown preview, but does highlight its Source tab', async () => {
        mocks.read.mockResolvedValue(response('# MARKDOWN-CURRENT'))
        setup({ sessionId: 'A', path: 'README.md', staged: undefined })
        expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('MARKDOWN-CURRENT')
        await settle(); expect(mocks.highlight).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Source' }))
        expect(screen.getByRole('code')).toHaveTextContent('# MARKDOWN-CURRENT')
        await waitFor(() => expect(document.querySelector('.probe-highlighted')).toHaveTextContent('MARKDOWN-CURRENT'))
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        expect(screen.queryByRole('code')).not.toBeInTheDocument()
    })

    it('does not highlight image content', async () => {
        mocks.read.mockResolvedValue(response('SYNTHETIC-IMAGE-BYTES'))
        setup({ sessionId: 'A', path: 'image.png', staged: false })
        await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
        await settle(); expect(mocks.highlight).not.toHaveBeenCalled()
    })

    it.each([
        ['below character budget', charBudgetSource(8 * 1024 - 1), true],
        ['at character budget', charBudgetSource(8 * 1024), false],
        ['below line budget', Array.from({ length: 199 }, () => 'let n = 1;').join('\n'), true],
        ['at line budget', Array.from({ length: 200 }, () => 'let n = 1;').join('\n'), false],
        ['below single-line budget', longComment(999), true],
        ['at single-line budget', longComment(1000), false],
        ['long second-line budget', `const first = 1;\n${longComment(1000)}`, false],
        ['original pathological single-line source', longComment(65535), false],
        ['known slow multiline source', charBudgetSource(65535), false],
        ['former shared line threshold', Array.from({ length: 999 }, () => 'let n = 1;').join('\n'), false],
    ] as const)('keeps complete source %s without over-budget automatic highlighting', async (_label, content, highlighted) => {
        mocks.read.mockResolvedValue(response(content))
        setup()
        expect(await screen.findByText('+DIFF-MARKER')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(screen.getByRole('code').textContent).toBe(content)
        expect(screen.getByRole('code')).toHaveAttribute('data-hapi-source-highlighting', highlighted ? 'auto' : 'plain-large')
        await settle()
        expect(screen.getByRole('code').textContent).toBe(content)
        if (highlighted) expect(mocks.highlight).toHaveBeenCalledWith(content, expect.anything())
        else {
            expect(mocks.highlight).not.toHaveBeenCalled()
            expect(document.querySelector('.probe-highlighted')).toBeNull()
        }
    })

})
