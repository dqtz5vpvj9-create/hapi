import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { formatFileMetadata } from '@/lib/file-metadata'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import FilePage, { SessionFile } from './file'

const goBackMock = vi.fn()
const copyMock = vi.hoisted(() => vi.fn())
const apiMock = vi.hoisted(() => ({ getGitDiffFile: vi.fn(), readSessionFile: vi.fn() }))

const sampleMarkdown = '# Heading\n\n| Col A | Col B |\n| --- | --- |\n| one | two |'
const filePath = 'docs/README.md'
const encodedPath = encodeBase64(filePath)
const encodedContent = encodeBase64(sampleMarkdown)
const fileSize = 1024
const fileModified = 1_784_175_060_000

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => ({
        path: encodedPath,
        staged: undefined,
    }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: apiMock,
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock,
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: copyMock,
    }),
}))

vi.mock('@/lib/shiki', () => ({
    langAlias: { md: 'markdown' },
    useShikiHighlighter: (content: string) => content,
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

function renderWithProviders(search?: { path?: string; staged?: boolean }, client?: QueryClient) {
    const queryClient = client ?? new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    const view = (search?: { path?: string; staged?: boolean }) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SessionFile sessionId="session-1" search={search ?? { path: encodedPath }} onBack={goBackMock} />
            </I18nProvider>
        </QueryClientProvider>
    )
    const result = render(view(search))
    return { ...result, rerenderFile: (search: { path?: string; staged?: boolean }) => result.rerender(view(search)) }
}

describe('SessionFile diff and read-only preview', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.sessionStorage.clear()
        apiMock.getGitDiffFile.mockReset().mockResolvedValue({ success: true, stdout: '' })
        apiMock.readSessionFile.mockReset().mockResolvedValue({
            success: true, content: encodedContent, size: fileSize, modified: fileModified,
        })
    })

    it('renders markdown preview by default and toggles to source', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Heading')
        })
        expect(screen.getByText(formatFileMetadata(fileSize, fileModified, 'en')!)).toBeInTheDocument()
        expect(screen.getAllByText(filePath)).toHaveLength(1)
        const previewCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(previewCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(previewCopyButton).not.toHaveClass('absolute')
        fireEvent.click(previewCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('opacity-80')
        expect(apiMock.getGitDiffFile).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourcePreview = screen.getByRole('code').closest('[data-hapi-file-source-preview="true"]')
        const sourceCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(sourcePreview).not.toBeNull()
        expect(sourcePreview).toContainElement(sourceCopyButton)
        expect(sourceCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(sourceCopyButton).not.toHaveClass('absolute')
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('uses the shared code-wrap preference for the source preview', async () => {
        window.localStorage.setItem('hapi-code-wrap', '1')
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourceCode = screen.getByRole('code')
        const sourcePre = sourceCode.closest('pre')
        const wrapToggle = screen.getByRole('button', { pressed: true })

        expect(wrapToggle).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre-wrap', wordBreak: 'break-word' })

        fireEvent.click(wrapToggle)

        expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre' })
        expect(window.localStorage.getItem('hapi-code-wrap')).toBeNull()
    })

    it('preserves the file preview scroll position across route remounts', async () => {
        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const firstScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(firstScrollRegion).not.toBeNull()
        firstScrollRegion.scrollTop = 123
        firstRender.unmount()

        renderWithProviders()
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const secondScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(123)
    })

    it('ignores cached diff failures when browsing an ordinary file outside a repository', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        client.setQueryData(queryKeys.gitFileDiff('session-1', filePath, false), {
            success: false, error: 'Not a git repository.\nusage: git diff --no-index',
        })
        renderWithProviders({ path: encodedPath }, client)

        expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Heading')
        expect(apiMock.getGitDiffFile).not.toHaveBeenCalled()
        expect(screen.queryByText('Diff unavailable.')).not.toBeInTheDocument()
        expect(screen.queryByText(/Not a git repository/)).not.toBeInTheDocument()
    })

    const patch = 'diff --git a/docs/README.md b/docs/README.md\n--- a/docs/README.md\n+++ b/docs/README.md\n@@ -1 +1 @@\n-old heading\n+new heading\n'

    it.each([true, false])('opens explicit changes with staged=%s as a diff', async (staged) => {
        apiMock.getGitDiffFile.mockResolvedValue({ success: true, stdout: patch })
        renderWithProviders({ path: encodedPath, staged })

        expect(await screen.findByText('+new heading')).toBeInTheDocument()
        expect(apiMock.getGitDiffFile).toHaveBeenCalledWith('session-1', filePath, staged)
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Heading')
    })

    it('allows reading the file while an explicitly requested diff is still pending', async () => {
        apiMock.getGitDiffFile.mockImplementation(() => new Promise(() => {}))
        renderWithProviders({ path: encodedPath, staged: false })

        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Heading')
    })

    it.each(['command', 'transport'])('keeps the file readable after a %s diff failure and collapses diagnostics', async (failure) => {
        const error = 'Not a git repository.\n' + 'usage: git diff --no-index\n'.repeat(200)
        if (failure === 'command') apiMock.getGitDiffFile.mockResolvedValue({ success: false, error })
        else apiMock.getGitDiffFile.mockRejectedValue(new Error(error))
        renderWithProviders({ path: encodedPath, staged: false })

        expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Heading')
        const summary = screen.getByText('Diff unavailable.')
        expect(summary.closest('details')).not.toHaveAttribute('open')
        expect(summary.closest('details')?.querySelector('pre')).toHaveTextContent('Not a git repository.')
        expect(summary.closest('details')?.querySelector('pre')).toHaveClass('max-h-40', 'overflow-auto')
    })

    it('resets the viewing intent when navigating between project files and changes', async () => {
        apiMock.getGitDiffFile.mockResolvedValue({ success: true, stdout: patch })
        const view = renderWithProviders({ path: encodedPath })
        expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
        view.rerenderFile({ path: encodedPath, staged: false })
        expect(await screen.findByText('+new heading')).toBeInTheDocument()
        view.rerenderFile({ path: encodedPath })
        expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Diff' })).not.toBeInTheDocument()
    })

    it('can display a deleted file diff even when reading the file fails', async () => {
        apiMock.getGitDiffFile.mockResolvedValue({ success: true, stdout: patch })
        apiMock.readSessionFile.mockResolvedValue({ success: false, error: 'File not found' })
        renderWithProviders({ path: encodedPath, staged: false })
        expect(await screen.findByText('+new heading')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'File' }))
        expect(await screen.findByText('Failed to read file: File not found')).toBeInTheDocument()
    })
})
