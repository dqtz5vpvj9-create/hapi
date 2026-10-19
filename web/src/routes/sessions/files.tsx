import { usePaneNavigate } from '@/workspace/PaneContext'
import { useWorkspacePanel } from '@/components/SessionWorkspace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import type { FileSearchItem, GitFileStatus } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import { FileManagementMenu, type FileManagementMenuState } from '@/components/SessionFiles/FileManagementMenu'
import { FileManagementDialog } from '@/components/SessionFiles/FileManagementDialog'
import { FileManagementToolbar } from '@/components/SessionFiles/FileManagementToolbar'
import { useFileManagement } from '@/components/SessionFiles/useFileManagement'
import type { FileManagerMutation, FileManagerTarget } from '@/components/SessionFiles/file-manager-types'
import { fileManagerBasename, fileManagerContains, fileManagerDropItems, isHiddenFileManagerPath, matchesFileManagerExclude } from '@/components/SessionFiles/file-manager-paths'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useFileMenuTrigger } from '@/hooks/useFileMenuTrigger'
import type { AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'
import { appendFileReferenceToComposerDraft } from '@/lib/file-composer'
import { resolveAbsoluteFilePath } from '@/lib/file-path'
import { normalizeFileManagerTarget, type SessionFilesSearch } from '@/lib/session-files-navigation'
import { SessionHeader } from '@/components/SessionHeader'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import {
    formatFileSearchError,
    formatGitStatusError,
    getDetachedBranchLabel,
    getProjectRootLabel,
} from '@/lib/files-i18n'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { formatFileMetadata } from '@/lib/file-metadata'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '@/lib/use-translation'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CloseIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
    DEFAULT_DIRECTORY_SORT,
    type DirectorySort,
    type DirectorySortDirection,
    type DirectorySortField,
    sortFileSearchItems,
} from '@/lib/directory-sort'

function RefreshIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
        </svg>
    )
}

function SortIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h13" /><path d="M3 12h9" /><path d="M3 18h5" />
            <path d="m17 15 3 3 3-3" /><path d="M20 18V6" />
        </svg>
    )
}

const DIRECTORY_SORT_STORAGE_KEY = 'hapi-directory-sort'
const FILES_TAB_STORAGE_KEY = 'hapi-files-tab'

type FilesTab = 'changes' | 'directories'

function readFilesTab(): FilesTab {
    try {
        const value = localStorage.getItem(FILES_TAB_STORAGE_KEY)
        if (value === 'changes' || value === 'directories') {
            return value
        }
    } catch {
        // Use the default when storage is unavailable.
    }
    return 'changes'
}

function persistFilesTab(tab: FilesTab): void {
    try {
        localStorage.setItem(FILES_TAB_STORAGE_KEY, tab)
    } catch {
        // Tab switching still works when storage is unavailable.
    }
}

function readDirectorySort(): DirectorySort {
    try {
        const value = JSON.parse(localStorage.getItem(DIRECTORY_SORT_STORAGE_KEY) ?? '') as Partial<DirectorySort>
        if (['name', 'modified', 'size'].includes(value.field ?? '') && ['asc', 'desc'].includes(value.direction ?? '')) {
            return value as DirectorySort
        }
    } catch {
        // Use the default when storage is unavailable or invalid.
    }
    return DEFAULT_DIRECTORY_SORT
}

function DirectorySortMenu(props: { sort: DirectorySort; onChange: (sort: DirectorySort) => void; embedded?: boolean }) {
    const { t } = useTranslation()
    const fields: Array<{ value: DirectorySortField; label: string }> = [
        { value: 'name', label: t('files.sort.name') },
        { value: 'modified', label: t('files.sort.modified') },
        { value: 'size', label: t('files.sort.size') },
    ]
    const directions: Array<{ value: DirectorySortDirection; label: string }> = props.sort.field === 'name'
        ? [{ value: 'asc', label: t('files.sort.nameAsc') }, { value: 'desc', label: t('files.sort.nameDesc') }]
        : props.sort.field === 'modified'
            ? [{ value: 'asc', label: t('files.sort.oldest') }, { value: 'desc', label: t('files.sort.newest') }]
            : [{ value: 'asc', label: t('files.sort.smallest') }, { value: 'desc', label: t('files.sort.largest') }]
    const optionClass = 'app-file-sort-option flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--app-subtle-bg)]'

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className={props.embedded
                        ? 'app-file-icon-action flex w-10 shrink-0 self-stretch items-center justify-center rounded-r-md rounded-l-sm text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                        : 'app-file-icon-action flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'}
                    title={t('files.sort.title')}
                    aria-label={t('files.sort.title')}
                >
                    <SortIcon />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50 w-48 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 shadow-lg">
                    <div className="px-2 pb-1 text-xs font-semibold text-[var(--app-hint)]">{t('files.sort.by')}</div>
                    {fields.map((field) => (
                        <button key={field.value} type="button" className={optionClass} onClick={() => props.onChange({ field: field.value, direction: props.sort.direction })}>
                            <span className="flex h-4 w-4 items-center justify-center">{props.sort.field === field.value ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
                            {field.label}
                        </button>
                    ))}
                    <div className="my-1 border-t border-[var(--app-divider)]" />
                    {directions.map((direction) => (
                        <button key={direction.value} type="button" className={optionClass} onClick={() => props.onChange({ ...props.sort, direction: direction.value })}>
                            <span className="flex h-4 w-4 items-center justify-center">{props.sort.direction === direction.value ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
                            {direction.label}
                        </button>
                    ))}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

function GitBranchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function StatusBadge(props: { status: GitFileStatus['status'] }) {
    const { label, color } = useMemo(() => {
        switch (props.status) {
            case 'added':
                return { label: 'A', color: 'var(--app-git-staged-color)' }
            case 'deleted':
                return { label: 'D', color: 'var(--app-git-deleted-color)' }
            case 'renamed':
                return { label: 'R', color: 'var(--app-git-renamed-color)' }
            case 'untracked':
                return { label: '?', color: 'var(--app-git-untracked-color)' }
            case 'conflicted':
                return { label: 'U', color: 'var(--app-git-deleted-color)' }
            default:
                return { label: 'M', color: 'var(--app-git-unstaged-color)' }
        }
    }, [props.status])

    return (
        <span
            className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ color, borderColor: color }}
        >
            {label}
        </span>
    )
}

function LineChanges(props: { added: number; removed: number }) {
    if (!props.added && !props.removed) return null

    return (
        <span className="flex items-center gap-1 text-[11px] font-mono">
            {props.added ? (
                <span className="text-[var(--app-diff-added-text)]">+{props.added}</span>
            ) : null}
            {props.removed ? (
                <span className="text-[var(--app-diff-removed-text)]">-{props.removed}</span>
            ) : null}
        </span>
    )
}

function GitFileRow(props: {
    file: GitFileStatus
    onOpen: () => void
    onOpenMenu: (point: AnchoredMenuPoint) => void
    showDivider: boolean
}) {
    const { t } = useTranslation()
    const subtitle = getProjectRootLabel(props.file.filePath, t)
    const rowHandlers = useFileMenuTrigger({
        onOpen: props.onOpen,
        onOpenMenu: props.onOpenMenu,
    })

    return (
        <button
            type="button"
            {...rowHandlers}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            <FileIcon fileName={props.file.fileName} size={22} />
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fileName}</div>
                <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
            </div>
            <div className="flex items-center gap-2">
                <LineChanges added={props.file.linesAdded} removed={props.file.linesRemoved} />
                <StatusBadge status={props.file.status} />
            </div>
        </button>
    )
}

function SearchResultRow(props: {
    file: FileSearchItem
    onOpen: () => void
    onOpenMenu: (point: AnchoredMenuPoint) => void
    showDivider: boolean
    active?: boolean
}) {
    const { t, locale } = useTranslation()
    const metadata = formatFileMetadata(props.file.size, props.file.modified, locale)
    const rowHandlers = useFileMenuTrigger({
        onOpen: props.onOpen,
        onOpenMenu: props.onOpenMenu,
    })
    const icon = props.file.fileType === 'file'
        ? <FileIcon fileName={props.file.fileName} size={22} />
        : <FolderIcon className="text-[var(--app-link)]" />

    return (
        <div data-file-path={props.file.fullPath} data-file-kind="file" className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''} ${props.active ? 'bg-[var(--app-subtle-bg)]' : ''}`}>
        <button type="button" {...rowHandlers} aria-current={props.active ? 'true' : undefined} className="app-file-tree-target flex min-w-0 flex-1 items-center gap-3 text-left">
            {icon}
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fullPath}</div>
                {metadata ? <div className="text-xs text-[var(--app-hint)]">{metadata}</div> : null}
            </div>
        </button>
        <button type="button" aria-label={t('files.manage.moreActions')} className="app-file-icon-action flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); props.onOpenMenu({ x: rect.right, y: rect.bottom }) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
        </div>
    )
}

function FileListSkeleton(props: { label: string; rows?: number }) {
    const titleWidths = ['w-1/3', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5']
    const subtitleWidths = ['w-1/2', 'w-2/3', 'w-3/4', 'w-1/3']
    const rows = props.rows ?? 6

    return (
        <div className="p-3 animate-pulse space-y-3" role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            {Array.from({ length: rows }).map((_, index) => (
                <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="flex-1 space-y-2">
                        <div className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                        <div className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                    </div>
                </div>
            ))}
        </div>
    )
}

const SCROLL_KEY_PREFIX = 'hapi-dir-scroll-'

export default function FilesPage() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId/files' })
    const search = useSearch({ from: '/sessions/$sessionId/files' })
    const goBack = useAppGoBack()
    const revealKey = useLocation({ select: location => location.state.__TSR_key })
    return <SessionFiles sessionId={sessionId} search={search} revealKey={revealKey} onBack={goBack} />
}

export function SessionFiles(props: {
    sessionId: string
    search: SessionFilesSearch
    revealKey?: string | number
    onBack: () => void
    activeFilePath?: string
    onOpenFile?: (path: string) => void
    foreground?: boolean
    beforeFileMutation?: (mutation: FileManagerMutation) => boolean | Promise<boolean>
    onFileMutation?: (mutation: FileManagerMutation) => void | Promise<void>
    onFileMutationSettled?: (mutation: FileManagerMutation) => void
}) {
    const workspacePanel = useWorkspacePanel()
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t, locale } = useTranslation()
    const navigate = usePaneNavigate()
    const queryClient = useQueryClient()
    const goBack = props.onBack
    const { sessionId, search } = props
    const { session } = useSession(api, sessionId)
    const scrollRef = useRef<HTMLDivElement>(null)

    const [activeTab, setActiveTab] = useState<FilesTab>(() => search.tab ?? (workspacePanel ? 'changes' : readFilesTab()))
    useEffect(() => {
        if (search.tab || workspacePanel) setActiveTab(search.tab ?? 'changes')
    }, [search.tab, workspacePanel])
    const [directorySort, setDirectorySort] = useState<DirectorySort>(readDirectorySort)
    const [fileMenu, setFileMenu] = useState<FileManagementMenuState | null>(null)
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
    const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem('hapi-file-show-hidden') === 'true' } catch { return false } })
    const [exclude, setExclude] = useState<string[]>(() => {
        try {
            const stored: unknown = JSON.parse(localStorage.getItem('hapi-file-exclude') ?? '[]')
            return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string' && value.length <= 256).slice(0, 32) : []
        } catch { return [] }
    })
    const [collapseKey, setCollapseKey] = useState(0)
    const [revealedDirectory, setRevealedDirectory] = useState<{ path: string; key: number }>()
    const [localReveal, setLocalReveal] = useState<{ path: string; key: number }>()
    const [dropActive, setDropActive] = useState(false)
    const [collectingDrop, setCollectingDrop] = useState(false)
    const collectingDropRef = useRef(false)
    const [copyError, setCopyError] = useState<string | null>(null)
    const uploadInput = useRef<HTMLInputElement>(null)
    const folderUploadInput = useRef<HTMLInputElement>(null)
    const uploadDirectory = useRef('')
    const currentSession = useRef(sessionId)
    currentSession.current = sessionId
    const currentApi = useRef(api)
    currentApi.current = api
    const searchQuery = search.query ?? ''
    const fileTarget = normalizeFileManagerTarget(localReveal?.path ?? search.target)
    const foreground = props.foreground !== false
    const caseInsensitive = /^[A-Za-z]:[\\/]/.test(session?.metadata?.path ?? '')

    useEffect(() => {
        setFileMenu(null); setSelectedPaths(new Set()); setLocalReveal(undefined); setRevealedDirectory(undefined); setCopyError(null)
    }, [api, sessionId])
    useEffect(() => { setLocalReveal(undefined) }, [search.target, props.revealKey])
    useEffect(() => { try { localStorage.setItem('hapi-file-show-hidden', String(showHidden)); localStorage.setItem('hapi-file-exclude', JSON.stringify(exclude)) } catch { /* Preferences are optional. */ } }, [exclude, showHidden])

    const openFileMenu = useCallback((path: string, point: AnchoredMenuPoint) => {
        setFileMenu({ target: { path, name: fileManagerBasename(path), kind: 'file' }, point })
    }, [])

    const closeFileMenu = useCallback(() => setFileMenu(null), [])

    const setSearchQuery = useCallback((query: string) => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: {
                ...(activeTab === 'directories' ? { tab: 'directories' as const } : {}),
                ...(query ? { query } : {}),
            },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [activeTab, navigate, sessionId])

    useEffect(() => {
        try {
            localStorage.setItem(DIRECTORY_SORT_STORAGE_KEY, JSON.stringify(directorySort))
        } catch {
            // Sorting still works when storage is unavailable.
        }
    }, [directorySort])

    useEffect(() => {
        if (search.tab) {
            setActiveTab(search.tab)
            persistFilesTab(search.tab)
        }
    }, [search.tab])

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        const scope = api?.getForkOperationScope?.()
        const key = `${SCROLL_KEY_PREFIX}${scope ? `${scope}:` : ''}${sessionId}:${activeTab}${searchQuery ? ':search' : ''}`
        try {
            const saved = sessionStorage.getItem(key)
            if (saved !== null && !(fileTarget && activeTab === 'directories' && !searchQuery)) el.scrollTop = Number(saved)
        } catch {
            // ignore
        }
        return () => {
            try {
                sessionStorage.setItem(key, String(el.scrollTop))
            } catch {
                // ignore
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, fileTarget, searchQuery, sessionId, session?.id])

    const {
        status: gitStatus,
        error: gitError,
        isLoading: gitLoading,
        refetch: refetchGit
    } = useGitStatusFiles(foreground && activeTab === 'changes' ? api : null, sessionId)

    const shouldSearch = Boolean(searchQuery)

    const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
        enabled: shouldSearch && foreground
    })
    const sortedSearchResults = useMemo(
        () => sortFileSearchItems(searchResults.files.filter(file => (showHidden || !isHiddenFileManagerPath(file.fullPath)) && !matchesFileManagerExclude(file.fullPath, exclude)), directorySort, locale),
        [directorySort, exclude, locale, searchResults.files, showHidden]
    )

    const handleOpenFile = useCallback((path: string, staged?: boolean) => {
        if (staged === undefined && props.onOpenFile) { props.onOpenFile(path); return }
        const fileSearch = {
            path: encodeBase64(path),
            ...(staged !== undefined ? { staged } : {}),
            ...(activeTab === 'directories' ? { tab: 'directories' as const } : {}),
            ...(searchQuery ? { query: searchQuery } : {}),
            ...(fileTarget ? { target: fileTarget } : {}),
        }
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: fileSearch,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [activeTab, fileTarget, navigate, props.onOpenFile, searchQuery, sessionId])

    const handleMutation = useCallback(async (mutation: FileManagerMutation) => {
        await props.onFileMutation?.(mutation)
        if (currentSession.current !== mutation.sessionId) return
        if (mutation.operation === 'delete' || mutation.operation === 'move' || mutation.operation === 'rename') {
            setSelectedPaths(previous => new Set([...previous].filter(path => !mutation.paths.some(source => fileManagerContains(source, path, caseInsensitive)))))
            setLocalReveal(previous => previous && mutation.paths.some(source => fileManagerContains(source, previous.path, caseInsensitive)) ? undefined : previous)
        }
    }, [caseInsensitive, props.onFileMutation])
    const revealDirectory = useCallback((path: string) => {
        setRevealedDirectory(previous => ({ path, key: (previous?.key ?? 0) + 1 }))
    }, [])
    const management = useFileManagement({
        api, sessionId, caseInsensitive,
        beforeFileMutation: props.beforeFileMutation,
        onFileMutation: handleMutation,
        onFileMutationSettled: props.onFileMutationSettled,
        onOpenFile: handleOpenFile,
        onRevealDirectory: revealDirectory,
    })
    const requestUpload = useCallback((directory = '', folder = false) => {
        uploadDirectory.current = directory
        const input = folder ? folderUploadInput.current : uploadInput.current
        if (input) { input.value = ''; input.click() }
    }, [])
    const copyPaths = useCallback(async (paths: string[]) => {
        try { await safeCopyToClipboard(paths.join('\n')); setCopyError(null) }
        catch (cause) { setCopyError(cause instanceof Error ? cause.message : t('files.manage.failed')) }
    }, [t])
    const selectedTargets = [...selectedPaths].map(path => ({ path, name: fileManagerBasename(path), kind: 'file' as const }))
    const uploadDrop = (data: DataTransfer, directory = '') => {
        setDropActive(false)
        if (management.busy || collectingDropRef.current) return
        collectingDropRef.current = true
        setCollectingDrop(true)
        const capturedSession = sessionId
        const capturedApi = api
        // The helper synchronously captures file-system handles before its first await.
        void fileManagerDropItems(data).then(async items => {
            if (currentSession.current === capturedSession && currentApi.current === capturedApi) await management.uploadItems(items, directory)
        }).catch(cause => {
            if (currentSession.current === capturedSession && currentApi.current === capturedApi) setCopyError(cause instanceof Error ? cause.message : t('files.manage.failed'))
        }).finally(() => { collectingDropRef.current = false; setCollectingDrop(false) })
    }

    const handleAddFileToComposer = useCallback((path: string) => {
        appendFileReferenceToComposerDraft(sessionId, path)
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    const branchLabel = getDetachedBranchLabel(gitStatus?.branch, t)
    const showGitErrorBanner = Boolean(gitError)
    const gitErrorMessage = useMemo(
        () => (gitError ? formatGitStatusError(gitError, t) : null),
        [gitError, t]
    )
    const searchErrorMessage = useMemo(
        () => (searchResults.error ? formatFileSearchError(searchResults.error, t) : null),
        [searchResults.error, t]
    )
    const rootLabel = useMemo(() => {
        const base = session?.metadata?.path ?? sessionId
        const parts = base.split(/[/\\]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : base
    }, [session?.metadata?.path, sessionId])

    const handleRefresh = useCallback(() => {
        if (searchQuery) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.sessionFiles(sessionId, searchQuery)
            })
            return
        }

        if (activeTab === 'directories') {
            void queryClient.invalidateQueries({
                queryKey: ['session-directory', sessionId]
            })
            return
        }

        void refetchGit()
    }, [activeTab, queryClient, refetchGit, searchQuery, sessionId])

    useEffect(() => {
        if (!foreground) return
        const refreshVisibleFiles = () => {
            if (document.visibilityState === 'visible') handleRefresh()
        }
        window.addEventListener('focus', refreshVisibleFiles)
        return () => window.removeEventListener('focus', refreshVisibleFiles)
    }, [foreground, handleRefresh])

    const handleTabChange = useCallback((nextTab: FilesTab) => {
        setActiveTab(nextTab)
        persistFilesTab(nextTab)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: {
                ...(nextTab === 'directories' ? { tab: nextTab } : {}),
                ...(searchQuery ? { query: searchQuery } : {}),
            },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, searchQuery, sessionId])

    const handleToggleFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    const handleToggleOutline = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            search: { outline: true },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    if (!session) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <LoadingState label={t('loading.files')} className="text-sm" />
            </div>
        )
    }

    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            onDragOver={event => {
                if (activeTab !== 'directories' || !foreground || !event.dataTransfer.types.includes('Files')) return
                event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true)
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false) }}
            onDrop={event => {
                if (activeTab !== 'directories' || !foreground || !event.dataTransfer.types.includes('Files')) return
                event.preventDefault(); event.stopPropagation(); setDropActive(false)
                uploadDrop(event.dataTransfer)
            }}
        >
            {workspacePanel ? null : <SessionHeader
                session={session}
                onBack={goBack}
                onToggleFiles={session.metadata?.path ? handleToggleFiles : undefined}
                filesActive={true}
                onToggleOutline={handleToggleOutline}
                outlineActive={false}
                api={api}
                titleSuggestionAvailable={titleSuggestionAvailable}
                onSessionDeleted={goBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        session.id,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId/files',
                            params: { sessionId: newSessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />}

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <div className="relative min-w-0 flex-1">
                        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]" />
                        <input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('files.page.searchPlaceholder')}
                            className="app-files-search-input h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-20 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                        {searchQuery ? (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="app-file-icon-action app-files-search-clear absolute inset-y-0 right-10 flex items-center rounded p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                title={t('sessions.search.clear')}
                                aria-label={t('sessions.search.clear')}
                            >
                                <CloseIcon className="h-3.5 w-3.5" />
                            </button>
                        ) : null}
                        {activeTab === 'directories' || searchQuery ? (
                            <div className="absolute inset-y-0 right-0 flex items-stretch">
                                <DirectorySortMenu sort={directorySort} onChange={setDirectorySort} embedded />
                            </div>
                        ) : null}
                    </div>
                    <Button
                        variant="outline"
                        type="button"
                        onClick={handleRefresh}
                        className="app-file-icon-action h-9 w-9 shrink-0 px-0"
                        title={t('files.page.refreshFilesystem')}
                        aria-label={t('files.page.refreshFilesystem')}
                    >
                        <RefreshIcon />
                    </Button>
                </div>
            </div>

            {activeTab === 'directories' ? <FileManagementToolbar
                busy={management.busy || collectingDrop}
                showHidden={showHidden}
                exclude={exclude}
                onShowHidden={() => setShowHidden(value => !value)}
                onExclude={setExclude}
                onNewFile={() => void management.arm('create-file', [])}
                onNewFolder={() => void management.arm('create-directory', [])}
                onUpload={() => requestUpload()}
                onUploadFolder={() => requestUpload('', true)}
                onCollapse={() => setCollapseKey(value => value + 1)}
            /> : null}
            <input ref={uploadInput} type="file" multiple hidden aria-label={t('files.manage.uploadFiles')} onChange={event => { void management.uploadFiles([...(event.target.files ?? [])], uploadDirectory.current); event.target.value = '' }} />
            <input ref={folderUploadInput} type="file" multiple hidden {...{ webkitdirectory: '' }} aria-label={t('files.manage.uploadFolder')} onChange={event => { void management.uploadFiles([...(event.target.files ?? [])], uploadDirectory.current); event.target.value = '' }} />
            {management.error && !management.dialog || copyError ? <div role="alert" className="flex items-start gap-2 border-b border-[var(--app-divider)] bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                <span className="min-w-0 flex-1 break-words">{copyError ?? management.error}</span>
                <button type="button" aria-label={t('button.close')} onClick={() => { management.clearError(); setCopyError(null) }}><CloseIcon className="h-4 w-4" /></button>
            </div> : null}
            {management.upload ? <div role="status" className="space-y-2 border-b border-[var(--app-divider)] px-3 py-2 text-xs">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{t('files.manage.uploading', { completed: management.upload.completed, total: management.upload.total, name: management.upload.current })}</span><button type="button" className="shrink-0 underline" disabled={management.upload.cancelled} onClick={management.cancelUpload}>{t(management.upload.cancelled ? 'files.manage.cancellingUpload' : 'files.manage.cancelUpload')}</button></div>
                <progress value={management.upload.completed} max={management.upload.total} className="h-1.5 w-full" />
            </div> : management.status ? <div role="status" className="border-b border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">{management.status}</div> : null}
            {selectedPaths.size && activeTab === 'directories' ? <div role="toolbar" aria-label={t('files.manage.selected', { count: selectedPaths.size })} className="flex flex-wrap items-center gap-2 border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs">
                <span>{t('files.manage.selected', { count: selectedPaths.size })}</span>
                <button type="button" className="underline" onClick={() => void copyPaths([...selectedPaths])}>{t('files.manage.copyPaths')}</button>
                <button type="button" className="underline" disabled={management.busy} onClick={() => void management.arm('move', selectedTargets)}>{t('files.manage.moveSelected')}</button>
                <button type="button" className="underline" disabled={management.busy} onClick={() => void management.arm('copy', selectedTargets)}>{t('files.manage.copySelected')}</button>
                <button type="button" className="text-red-600 underline dark:text-red-400" disabled={management.busy} onClick={() => void management.arm('delete', selectedTargets)}>{t('files.manage.deleteSelected')}</button>
                <button type="button" className="ml-auto underline" onClick={() => setSelectedPaths(new Set())}>{t('files.manage.clearSelection')}</button>
            </div> : null}

            {workspacePanel ? null : <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)]" role="tablist">
                <div className="mx-auto w-full max-w-content grid grid-cols-2">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'changes'}
                        onClick={() => handleTabChange('changes')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'changes' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        {t('files.tab.changes')}
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'changes' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'directories'}
                        onClick={() => handleTabChange('directories')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'directories' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        {t('files.tab.directories')}
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'directories' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                </div>
            </div>}

            {!gitLoading && gitStatus && !searchQuery && activeTab === 'changes' ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
                        <div className="flex items-center gap-2 text-sm">
                            <GitBranchIcon className="text-[var(--app-hint)]" />
                            <span className="font-semibold">{branchLabel}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('files.branch.summary', {
                                staged: gitStatus.totalStaged,
                                unstaged: gitStatus.totalUnstaged,
                            })}
                        </div>
                    </div>
                </div>
            ) : null}

            <div
                ref={scrollRef}
                data-hapi-session-files-scroll="true"
                className="app-scroll-y flex-1 min-h-0"
            >
                <div className="mx-auto w-full max-w-content">
                    <div hidden={shouldSearch || activeTab !== 'directories'}>
                        <DirectoryTree
                            key={sessionId}
                            api={api}
                            sessionId={sessionId}
                            rootLabel={rootLabel}
                            onOpenFile={(path) => handleOpenFile(path)}
                            onRequestFileMenu={openFileMenu}
                            onRequestEntryMenu={(target, point) => setFileMenu({ target, point })}
                            onRequestDownload={target => void management.download(target)}
                            onDropFiles={uploadDrop}
                            sort={directorySort}
                            target={fileTarget}
                            activeFilePath={props.activeFilePath}
                            revealKey={localReveal?.key ?? props.revealKey}
                            revealDirectory={revealedDirectory}
                            collapseKey={collapseKey}
                            caseInsensitive={caseInsensitive}
                            showHidden={showHidden}
                            exclude={exclude}
                            foreground={foreground && !shouldSearch && activeTab === 'directories'}
                            selectedPaths={selectedPaths}
                            onSelectedPathsChange={setSelectedPaths}
                        />
                    </div>
                    {showGitErrorBanner && activeTab === 'changes' ? (
                        <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]">
                            {gitErrorMessage}
                        </div>
                    ) : null}
                    {shouldSearch ? (
                        searchResults.isLoading ? (
                            <FileListSkeleton label={t('loading.files')} />
                        ) : searchResults.error ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{searchErrorMessage}</div>
                        ) : sortedSearchResults.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                {t('files.search.empty')}
                            </div>
                        ) : (
                            <div className="border-t border-[var(--app-divider)]">
                                {sortedSearchResults.map((file, index) => (
                                    <SearchResultRow
                                        key={file.fullPath}
                                        file={file}
                                        onOpen={() => handleOpenFile(file.fullPath)}
                                        onOpenMenu={(point) => openFileMenu(file.fullPath, point)}
                                        showDivider={index < sortedSearchResults.length - 1}
                                        active={props.activeFilePath === file.fullPath}
                                    />
                                ))}
                            </div>
                        )
                    ) : activeTab === 'directories' ? null : gitLoading ? (
                        <FileListSkeleton label={t('loading.git')} />
                    ) : (
                        <div>
                            {gitStatus?.stagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-staged-color)]">
                                        {t('files.changes.section.staged', { n: gitStatus.stagedFiles.length })}
                                    </div>
                                    {gitStatus.stagedFiles.map((file, index) => (
                                        <GitFileRow
                                            key={`staged-${file.fullPath}-${index}`}
                                            file={file}
                                            onOpen={() => handleOpenFile(file.fullPath, file.isStaged)}
                                            onOpenMenu={(point) => openFileMenu(file.fullPath, point)}
                                            showDivider={index < gitStatus.stagedFiles.length - 1 || gitStatus.unstagedFiles.length > 0}
                                        />
                                    ))}
                                </div>
                            ) : null}

                            {gitStatus?.unstagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-unstaged-color)]">
                                        {t('files.changes.section.unstaged', { n: gitStatus.unstagedFiles.length })}
                                    </div>
                                    {gitStatus.unstagedFiles.map((file, index) => (
                                        <GitFileRow
                                            key={`unstaged-${file.fullPath}-${index}`}
                                            file={file}
                                            onOpen={() => handleOpenFile(file.fullPath, file.isStaged)}
                                            onOpenMenu={(point) => openFileMenu(file.fullPath, point)}
                                            showDivider={index < gitStatus.unstagedFiles.length - 1}
                                        />
                                    ))}
                                </div>
                            ) : null}

                            {!gitStatus ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    {t('files.changes.empty.unavailable')}
                                </div>
                            ) : null}

                            {gitStatus && gitStatus.stagedFiles.length === 0 && gitStatus.unstagedFiles.length === 0 ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    {t('files.changes.empty.none')}
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>

            <FileManagementMenu
                menu={foreground ? fileMenu : null}
                busy={management.busy}
                onClose={closeFileMenu}
                onAction={(action, target) => void management.arm(action, action === 'create-file' || action === 'create-directory' ? [] : [target], target.kind === 'directory' ? target.path : '')}
                onOpen={target => handleOpenFile(target.path)}
                onReveal={target => {
                    if (target.kind === 'directory') revealDirectory(target.path)
                    else setLocalReveal(previous => ({ path: target.path, key: (previous?.key ?? 0) + 1 }))
                    setActiveTab('directories')
                    if (searchQuery) setSearchQuery('')
                }}
                onDownload={target => void management.download(target)}
                onUpload={target => requestUpload(target.path)}
                onCopyPath={(absolute, target) => void copyPaths([absolute ? resolveAbsoluteFilePath(session.metadata?.path, target.path) : target.path || '.'])}
                onReference={target => handleAddFileToComposer(target.path)}
            />
            <FileManagementDialog
                state={foreground ? management.dialog : null}
                busy={management.busy}
                error={management.error}
                onClose={management.closeDialog}
                onSubmit={management.submit}
                onInspectAgain={() => { const state = management.dialog; if (state) { management.closeDialog(); void management.arm(state.action, state.sources, state.parent) } }}
            />
            {dropActive && !management.busy ? <div className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--app-link)] bg-[var(--app-bg)]/90 p-4 text-center text-sm">{t('files.manage.dropHere', { path: rootLabel })}</div> : null}
        </div>
    )
}
