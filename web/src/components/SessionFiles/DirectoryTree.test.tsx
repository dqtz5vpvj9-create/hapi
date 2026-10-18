import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { DEFAULT_DIRECTORY_SORT } from '@/lib/directory-sort'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import type { FileManagerTarget } from './file-manager-types'

const mocks = vi.hoisted(() => ({
    reads: vi.fn(),
    readFile: vi.fn(),
    byPath: null as Record<string, Array<{ name: string; type: 'file' | 'directory' | 'other'; isSymbolicLink?: boolean }>> | null,
    loadingPath: null as string | null,
    errorPath: null as string | null,
    entries: [
        { name: 'README.md', type: 'file' as const, size: 12, modified: 1_784_175_060_000 },
        { name: 'src', type: 'directory' as const },
    ] as Array<{ name: string; type: 'file' | 'directory'; size?: number; modified?: number }>,
}))

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: (_api: unknown, _sessionId: string, path: string, options: { enabled: boolean }) => {
        mocks.reads(path, options)
        return {
            entries: mocks.byPath ? mocks.byPath[path] ?? [] : mocks.entries,
            error: mocks.errorPath === path ? 'Permission denied' : null,
            isLoading: mocks.loadingPath === path,
            refetch: vi.fn(),
        }
    },
}))

function renderTree(handlers: {
    onOpenFile?: () => void
    onRequestFileMenu?: (path: string, point: { x: number; y: number }) => void
    target?: string
    caseInsensitive?: boolean
    revealKey?: string | number
    showHidden?: boolean
    exclude?: readonly string[]
    activeFilePath?: string
    foreground?: boolean
    selectedPaths?: Set<string>
    onSelectedPathsChange?: (paths: Set<string>) => void
    onRequestEntryMenu?: (target: FileManagerTarget, point: { x: number; y: number }) => void
} = {}) {
    const onOpenFile = handlers.onOpenFile ?? vi.fn()
    const onRequestFileMenu = handlers.onRequestFileMenu ?? vi.fn()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (target = handlers.target, revealKey = handlers.revealKey) => (
        <QueryClientProvider client={client}>
            <I18nProvider>
                <ToastProvider>
                    <DirectoryTree
                        api={{ readSessionFile: mocks.readFile } as never}
                        sessionId="session-1"
                        rootLabel="project"
                        onOpenFile={onOpenFile}
                        onRequestFileMenu={onRequestFileMenu}
                        sort={DEFAULT_DIRECTORY_SORT}
                        target={target}
                        caseInsensitive={handlers.caseInsensitive}
                        revealKey={revealKey}
                        showHidden={handlers.showHidden}
                        exclude={handlers.exclude}
                        activeFilePath={handlers.activeFilePath}
                        foreground={handlers.foreground}
                        selectedPaths={handlers.selectedPaths}
                        onSelectedPathsChange={handlers.onSelectedPathsChange}
                        onRequestEntryMenu={handlers.onRequestEntryMenu}
                    />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
    const rendered = render(ui())

    return { onOpenFile, onRequestFileMenu, rerenderTarget: (target: string, revealKey?: string | number) => rendered.rerender(ui(target, revealKey)) }
}

/** The file name button (a directory row's download button also mentions the name in its aria-label). */
function fileRow(): HTMLButtonElement {
    return screen.getByText('README.md').closest('button') as HTMLButtonElement
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    mocks.byPath = null
    mocks.loadingPath = null
    mocks.errorPath = null
})

afterEach(() => cleanup())

describe('DirectoryTree reveals file targets', () => {
    beforeEach(() => {
        mocks.byPath = {
            '': [{ name: 'build', type: 'directory' }, { name: 'unrelated', type: 'directory' }, { name: 'README.md', type: 'file' }],
            build: [{ name: 'images', type: 'directory' }, { name: 'later.custom', type: 'file' }],
            'build/images': [{ name: 'image.tar.gz', type: 'file' }],
        }
    })

    it('lazily expands only ancestors, highlights and scrolls without opening or reading bytes', () => {
        const scroll = vi.fn()
        const original = HTMLElement.prototype.scrollIntoView
        HTMLElement.prototype.scrollIntoView = scroll
        try {
            window.sessionStorage.setItem('hapi-dir-expanded-session-1', '[]')
            const { onOpenFile } = renderTree({ target: 'build/images/image.tar.gz' })
            expect(screen.getByText('image.tar.gz').closest('button')).toHaveAttribute('aria-current', 'true')
            const fetched = new Set(mocks.reads.mock.calls.filter(([, options]) => options.enabled).map(([path]) => path))
            expect([...fetched].sort()).toEqual(['', 'build', 'build/images'])
            expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
            expect(onOpenFile).not.toHaveBeenCalled()
            expect(mocks.readFile).not.toHaveBeenCalled()
        } finally { HTMLElement.prototype.scrollIntoView = original }
    })

    it('replaces the selected row when a later link targets another file', () => {
        const { rerenderTarget } = renderTree({ target: 'build/images/image.tar.gz' })
        rerenderTarget('build/later.custom')
        expect(screen.getByText('later.custom').closest('button')).toHaveAttribute('aria-current', 'true')
        expect(screen.getByText('image.tar.gz').closest('button')).not.toHaveAttribute('aria-current')
    })

    it('reveals the same target again after its parent was collapsed', () => {
        const target = 'build/images/image.tar.gz'
        const { rerenderTarget } = renderTree({ target, revealKey: 1 })
        fireEvent.click(screen.getByRole('button', { name: 'build' }))
        expect(screen.queryByText('image.tar.gz')).toBeNull()
        rerenderTarget(target, 2)
        expect(screen.getByText('image.tar.gz').closest('button')).toHaveAttribute('aria-current', 'true')
    })

    it.each(['build/images/missing.tar.gz', 'missing/image.tar.gz'])('keeps the directory usable and explains missing %s', target => {
        renderTree({ target })
        expect(screen.getByRole('alert')).toHaveTextContent(`Cannot find or access this file: ${target}`)
        expect(screen.getByText('README.md')).toBeVisible()
        expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('does not report a pending target as missing or block other directories', () => {
        mocks.loadingPath = 'build/images'
        renderTree({ target: 'build/images/image.tar.gz' })
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.getByText('README.md')).toBeVisible()
    })

    it('shows an ancestor read error without opening a different file', () => {
        mocks.errorPath = 'build'
        const { onOpenFile } = renderTree({ target: 'build/images/image.tar.gz' })
        expect(screen.getByText('Failed to list directory: Permission denied')).toBeVisible()
        expect(screen.getByText('README.md')).toBeVisible()
        expect(onOpenFile).not.toHaveBeenCalled()
    })

    it('does not follow a symlink entry while revealing a target', () => {
        mocks.byPath![''] = [{ name: 'outside', type: 'other' }]
        renderTree({ target: 'outside/image.tar.gz' })
        expect(screen.getByRole('alert')).toBeVisible()
        expect(mocks.reads.mock.calls.some(([path]) => path === 'outside')).toBe(false)
    })

    it('matches Windows ancestors and file names case-insensitively', () => {
        mocks.byPath = { '': [{ name: 'Build', type: 'directory' }], Build: [{ name: 'IMAGE.tar.gz', type: 'file' }] }
        renderTree({ target: 'build/image.tar.gz', caseInsensitive: true })
        expect(screen.getByText('IMAGE.tar.gz').closest('button')).toHaveAttribute('aria-current', 'true')
        expect(screen.queryByRole('alert')).toBeNull()
    })
})

describe('DirectoryTree file context menu', () => {
    it('requests the menu on right-click with the entry path and pointer', () => {
        const { onRequestFileMenu } = renderTree()

        fireEvent.contextMenu(fileRow(), { clientX: 321, clientY: 123 })

        expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 321, y: 123 })
    })

    it('requests the menu on touch long-press and does not open the file on release', () => {
        vi.useFakeTimers()
        try {
            const { onOpenFile, onRequestFileMenu } = renderTree()

            fireEvent.touchStart(fileRow(), { touches: [{ clientX: 44, clientY: 55 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })

            expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 44, y: 55 })
            expect(onOpenFile).not.toHaveBeenCalled()

            fireEvent.touchEnd(fileRow(), { changedTouches: [{ clientX: 44, clientY: 55 }] })
            expect(onOpenFile).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('DirectoryTree file management surface', () => {
    it('offers the same directory and root operations through visible overflow buttons', () => {
        const onRequestEntryMenu = vi.fn()
        renderTree({ onRequestEntryMenu })
        fireEvent.click(screen.getByRole('button', { name: 'File actions for src' }))
        expect(onRequestEntryMenu).toHaveBeenCalledWith({ path: 'src', name: 'src', kind: 'directory' }, expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
        fireEvent.contextMenu(screen.getByRole('button', { name: 'project' }), { clientX: 21, clientY: 34 })
        expect(onRequestEntryMenu).toHaveBeenLastCalledWith({ path: '', name: 'project', kind: 'directory' }, { x: 21, y: 34 })
    })

    it('selects with checkboxes and modified clicks without opening or reading the file', () => {
        const onSelectedPathsChange = vi.fn()
        const { onOpenFile } = renderTree({ selectedPaths: new Set(), onSelectedPathsChange })
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select README.md' }))
        expect(onSelectedPathsChange).toHaveBeenCalledWith(new Set(['README.md']))
        fireEvent.click(fileRow(), { ctrlKey: true })
        expect(onSelectedPathsChange).toHaveBeenLastCalledWith(new Set(['README.md']))
        expect(onOpenFile).not.toHaveBeenCalled()
        expect(mocks.readFile).not.toHaveBeenCalled()
    })

    it('filters hidden files and excluded subtrees while a direct reveal remains reachable', () => {
        mocks.byPath = {
            '': [{ name: '.env', type: 'file' }, { name: 'build', type: 'directory' }, { name: 'ignored', type: 'directory' }, { name: 'visible.md', type: 'file' }],
            build: [{ name: 'result.txt', type: 'file' }],
        }
        renderTree({ showHidden: false, exclude: ['build', 'ignored'], target: 'build/result.txt' })
        expect(screen.queryByText('.env')).toBeNull()
        expect(screen.queryByText('ignored')).toBeNull()
        expect(screen.getByText('visible.md')).toBeVisible()
        expect(screen.getByText('result.txt')).toBeVisible()
        expect(mocks.reads.mock.calls.some(([path]) => path === 'ignored')).toBe(false)
    })

    it('shows symlinks as manageable leaves without reading or following the target', () => {
        mocks.byPath = { '': [{ name: 'outside-link', type: 'other', isSymbolicLink: true }] }
        const onRequestEntryMenu = vi.fn()
        const { onOpenFile } = renderTree({ onRequestEntryMenu })
        fireEvent.click(screen.getByRole('button', { name: /outside-link Symbolic link/ }))
        expect(onOpenFile).not.toHaveBeenCalled()
        expect(mocks.readFile).not.toHaveBeenCalled()
        expect(mocks.reads.mock.calls.some(([path]) => path === 'outside-link')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'File actions for outside-link' }))
        expect(onRequestEntryMenu).toHaveBeenCalledWith(expect.objectContaining({ kind: 'symlink', path: 'outside-link' }), expect.anything())
    })

    it('disables directory reads while the tree is parked', () => {
        renderTree({ foreground: false })
        expect(mocks.reads).toHaveBeenCalled()
        expect(mocks.reads.mock.calls.every(([, options]) => !options.enabled)).toBe(true)
    })

    it('distinguishes the active editor from an explicit reveal target', () => {
        mocks.byPath = { '': [{ name: 'README.md', type: 'file' }, { name: 'other.md', type: 'file' }] }
        renderTree({ activeFilePath: 'README.md', target: 'other.md' })
        expect(screen.getByText('README.md').closest('button')).toHaveAttribute('aria-current', 'true')
        expect(screen.getByText('other.md').closest('button')).not.toHaveAttribute('aria-current')
        expect(screen.getByText('other.md').closest('[data-file-target]')).not.toBeNull()
    })
})
