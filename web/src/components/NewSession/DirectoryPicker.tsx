import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { MachineDirectoryEntry } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { ChevronUp, Folder, Refresh } from './TaskIcons'

const MAX_VISIBLE_ENTRIES = 300
const FILTER_THRESHOLD = 4
const MAX_RECENT_PATHS = 5
const LAST_PATH_STORAGE_KEY = 'hapi:directoryPicker:lastPath'

function isWindowsStylePath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
}

function normalizePath(path: string): string {
    const unified = path.replace(/[\\/]+/g, '/')
    if (unified === '/' || /^[A-Za-z]:\/$/.test(unified)) return unified
    return unified.replace(/\/+$/, '')
}

function joinPath(base: string, name: string): string {
    const normalized = normalizePath(base)
    if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
        return `${normalized}${name}`
    }
    const separator = isWindowsStylePath(base) ? '\\' : '/'
    return `${normalized}${separator}${name}`
}

function parentPath(path: string): string {
    const normalized = normalizePath(path)
    if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
    const index = normalized.lastIndexOf('/')
    const parent = index <= 0 ? '/' : normalized.slice(0, index)
    return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

function pathBasename(path: string): string {
    const normalized = normalizePath(path)
    if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? normalized
}

function tailPath(path: string, maxLength = 36): string {
    if (path.length <= maxLength) return path
    return `…${path.slice(path.length - maxLength + 1)}`
}

function isWithin(path: string, root: string): boolean {
    const p = normalizePath(path)
    const r = normalizePath(root)
    return p === r || p.startsWith(r === '/' ? '/' : `${r}/`)
}

function uniquePaths(paths: readonly string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const candidate of paths) {
        const trimmed = candidate.trim()
        if (trimmed === '') continue
        const key = normalizePath(trimmed)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(trimmed)
    }
    return result
}

function readLastChosenPath(machineId: string): string {
    try {
        const stored = localStorage.getItem(LAST_PATH_STORAGE_KEY)
        if (!stored) return ''
        const parsed: unknown = JSON.parse(stored)
        if (!parsed || typeof parsed !== 'object') return ''
        const value = (parsed as Record<string, unknown>)[machineId]
        return typeof value === 'string' ? value.trim() : ''
    } catch {
        return ''
    }
}

function rememberLastChosenPath(machineId: string, path: string): void {
    try {
        const stored = localStorage.getItem(LAST_PATH_STORAGE_KEY)
        const parsed: unknown = stored ? JSON.parse(stored) : {}
        const next = parsed && typeof parsed === 'object'
            ? { ...(parsed as Record<string, unknown>) }
            : {}
        next[machineId] = path
        localStorage.setItem(LAST_PATH_STORAGE_KEY, JSON.stringify(next))
    } catch {
        // Ignoring storage errors keeps the picker usable in private windows.
    }
}

type Crumb = { label: string; path: string }

function buildBreadcrumbs(path: string, root: string | null): Crumb[] {
    const current = normalizePath(path)
    const rootPath = root ? normalizePath(root) : null

    if (rootPath && isWithin(current, rootPath)) {
        const rootLabel = rootPath === '/' ? '/' : rootPath.split('/').filter(Boolean).pop() ?? rootPath
        const crumbs: Crumb[] = [{ label: rootLabel, path: rootPath }]
        const rest = current.slice(rootPath === '/' ? 1 : rootPath.length).split('/').filter(Boolean)
        let acc = rootPath
        for (const part of rest) {
            acc = acc === '/' ? `/${part}` : `${acc}/${part}`
            crumbs.push({ label: part, path: acc })
        }
        return crumbs
    }

    // Fallback for a path outside the machine's declared roots: show the
    // absolute chain so the user can still walk back up.
    const windows = isWindowsStylePath(current)
    const parts = current.split('/').filter(Boolean)
    const crumbs: Crumb[] = windows
        ? [{ label: parts[0] ?? '/', path: `${parts[0] ?? ''}/` }]
        : [{ label: '/', path: '/' }]
    let acc = windows ? `${parts[0] ?? ''}/` : ''
    for (const part of parts.slice(windows ? 1 : 0)) {
        acc = acc === '' || acc.endsWith('/') ? `${acc}${part}` : `${acc}/${part}`
        crumbs.push({ label: part, path: acc })
    }
    return crumbs
}

type PickerRow = {
    key: string
    label: string
    path: string
    isParent: boolean
    isRecent: boolean
    isGitRepo: boolean
}

function SearchIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </svg>
    )
}

/**
 * Inline directory browser for the new-session sheet.
 *
 * The previous sheet only offered a bare text field, so picking a folder meant
 * remembering and typing an absolute path. This lists real subfolders from the
 * selected machine, keeps the path editable for power users, and only commits
 * the choice when the user confirms.
 *
 * Recent places sit above the list, the current folder is always visible, and
 * the list supports arrow-key navigation so the sheet works with a keyboard as
 * well as a thumb.
 */
export function DirectoryPicker(props: {
    api: ApiClient
    machineId: string | null
    workspaceRoots: readonly string[]
    initialPath: string
    recentPaths: readonly string[]
    statusMessage?: string | null
    statusTone?: 'warning' | 'error' | null
    onSelect: (path: string) => void
}) {
    const { t } = useTranslation()
    const [pathInput, setPathInput] = useState(props.initialPath.trim())
    const [currentPath, setCurrentPath] = useState<string | null>(null)
    const [entries, setEntries] = useState<MachineDirectoryEntry[]>([])
    const [filter, setFilter] = useState('')
    const [showHidden, setShowHidden] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [activeIndex, setActiveIndex] = useState(-1)
    const requestSeq = useRef(0)
    const userNavigated = useRef(false)
    const initialLoadKey = useRef<string | null>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const breadcrumbRef = useRef<HTMLDivElement>(null)
    const filterRef = useRef<HTMLInputElement>(null)

    const loadDirectory = useCallback(async (
        path: string,
        options?: { includeHidden?: boolean; probe?: boolean }
    ): Promise<boolean> => {
        const trimmed = path.trim()
        if (!props.machineId || trimmed === '') return false
        const seq = ++requestSeq.current
        if (!options?.probe) userNavigated.current = true
        setIsLoading(true)
        if (!options?.probe) setError(null)
        try {
            const result = await props.api.listMachineDirectory(props.machineId, trimmed, {
                includeHidden: options?.includeHidden ?? showHidden
            })
            if (seq !== requestSeq.current) return false
            if (result.success && result.entries) {
                setEntries(result.entries)
                setCurrentPath(trimmed)
                setPathInput(trimmed)
                setFilter('')
                setActiveIndex(-1)
                setError(null)
                return true
            }
            if (!options?.probe) setError(result.error ?? t('directoryPicker.error'))
            return false
        } catch (err) {
            if (seq !== requestSeq.current) return false
            if (!options?.probe) {
                setError(err instanceof Error ? err.message : t('directoryPicker.error'))
            }
            return false
        } finally {
            if (seq === requestSeq.current) setIsLoading(false)
        }
    }, [props.api, props.machineId, showHidden, t])

    useEffect(() => {
        if (!props.machineId) return
        const loadKey = `${props.machineId}\u0000${props.initialPath.trim()}`
        if (initialLoadKey.current === loadKey) return
        initialLoadKey.current = loadKey

        const explicitPath = props.initialPath.trim()
        if (explicitPath !== '') {
            void loadDirectory(explicitPath)
            return
        }

        // No directory was supplied: resume the folder chosen last time on
        // this machine, then fall back to its recent projects and root.
        const candidates = uniquePaths([
            readLastChosenPath(props.machineId),
            ...props.recentPaths,
            ...props.workspaceRoots
        ])
        if (candidates.length === 0) return

        void (async () => {
            for (const candidate of candidates) {
                if (userNavigated.current) return
                if (await loadDirectory(candidate, { probe: true })) return
            }
            if (userNavigated.current) return
            setPathInput(candidates[0] ?? '')
            setError(t('directoryPicker.error'))
        })()
    }, [loadDirectory, props.initialPath, props.machineId, props.recentPaths, props.workspaceRoots, t])

    useEffect(() => {
        const element = breadcrumbRef.current
        if (element) element.scrollLeft = element.scrollWidth
    }, [currentPath, props.workspaceRoots])

    useEffect(() => {
        if (activeIndex < 0) return
        const row = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`)
        row?.scrollIntoView?.({ block: 'nearest' })
    }, [activeIndex])

    const directories = useMemo(() => {
        const dirs = entries.filter(entry => entry.type === 'directory')
        const sorted = dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        const needle = filter.trim().toLowerCase()
        if (needle === '') return sorted
        return sorted.filter(entry => entry.name.toLowerCase().includes(needle))
    }, [entries, filter])

    const recentPathSet = useMemo(
        () => new Set(props.recentPaths.map(path => normalizePath(path))),
        [props.recentPaths]
    )

    const visibleDirectories = directories.slice(0, MAX_VISIBLE_ENTRIES)
    const parent = currentPath ? parentPath(currentPath) : null

    const rows = useMemo<PickerRow[]>(() => {
        const result: PickerRow[] = []
        // While searching, keep the parent row out of the way so the first
        // match is one arrow key away instead of two.
        if (filter.trim() === '' && currentPath && parent && parent !== currentPath) {
            result.push({
                key: '__parent__',
                label: '..',
                path: parent,
                isParent: true,
                isRecent: false,
                isGitRepo: false
            })
        }
        for (const entry of visibleDirectories) {
            const target = currentPath ? joinPath(currentPath, entry.name) : entry.name
            result.push({
                key: entry.name,
                label: entry.name,
                path: target,
                isParent: false,
                isRecent: recentPathSet.has(normalizePath(target)),
                isGitRepo: entry.isGitRepo === true
            })
        }
        return result
    }, [currentPath, filter, parent, recentPathSet, visibleDirectories])

    useEffect(() => {
        setActiveIndex(index => (index >= rows.length ? -1 : index))
    }, [rows.length])

    const breadcrumbs = useMemo(() => {
        const base = currentPath ?? (props.initialPath.trim() || props.workspaceRoots[0] || null)
        if (!base) return []
        const root = props.workspaceRoots.find(candidate => isWithin(base, candidate)) ?? null
        return buildBreadcrumbs(base, root)
    }, [currentPath, props.initialPath, props.workspaceRoots])

    const typedPath = pathInput.trim()
    const selectedPath = typedPath !== '' ? typedPath : currentPath
    const canSelect = selectedPath !== null && props.machineId !== null
    const pathDiffersFromListed = currentPath !== null
        && typedPath !== ''
        && normalizePath(typedPath) !== normalizePath(currentPath)
    const recentPaths = useMemo(
        () => uniquePaths(props.recentPaths).slice(0, MAX_RECENT_PATHS),
        [props.recentPaths]
    )

    const goUp = useCallback(() => {
        if (!currentPath) return
        void loadDirectory(parentPath(currentPath))
    }, [currentPath, loadDirectory])

    const refresh = useCallback(() => {
        if (currentPath) void loadDirectory(currentPath)
    }, [currentPath, loadDirectory])

    const toggleHidden = useCallback(() => {
        const next = !showHidden
        setShowHidden(next)
        if (currentPath) void loadDirectory(currentPath, { includeHidden: next })
    }, [currentPath, loadDirectory, showHidden])

    const navigateTo = useCallback((path: string) => {
        setPathInput(path)
        void loadDirectory(path)
    }, [loadDirectory])

    const confirmSelection = useCallback(() => {
        const target = pathInput.trim() || currentPath
        if (!target) return
        if (props.machineId && currentPath && normalizePath(target) === normalizePath(currentPath)) {
            rememberLastChosenPath(props.machineId, target)
        }
        props.onSelect(target)
    }, [currentPath, pathInput, props.machineId, props.onSelect])

    const handleFilterKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (rows.length === 0) return
            event.preventDefault()
            setActiveIndex((index) => {
                if (event.key === 'ArrowDown') {
                    return index < 0 ? 0 : (index + 1) % rows.length
                }
                return index <= 0 ? rows.length - 1 : index - 1
            })
            return
        }
        if (event.key === 'Enter') {
            event.preventDefault()
            const active = activeIndex >= 0 ? rows[activeIndex] : undefined
            // Enter on a search with no explicit highlight opens the first
            // match instead of silently selecting the current folder.
            const target = active ?? (filter.trim() !== '' ? rows[0] : undefined)
            if (target) {
                navigateTo(target.path)
            } else {
                confirmSelection()
            }
            return
        }
        if (event.key === 'Escape' && filter !== '') {
            event.preventDefault()
            event.stopPropagation()
            setFilter('')
            setActiveIndex(-1)
        }
    }, [activeIndex, confirmSelection, filter, navigateTo, rows])

    if (!props.machineId) {
        return (
            <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                {t('directoryPicker.noMachine')}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={goUp}
                    disabled={!currentPath || isLoading}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-40"
                    title={t('directoryPicker.up')}
                    aria-label={t('directoryPicker.up')}
                >
                    <ChevronUp size={16} />
                </button>
                <input
                    type="text"
                    value={pathInput}
                    onChange={(event) => setPathInput(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault()
                            void loadDirectory(pathInput)
                        }
                    }}
                    placeholder={t('newSession.placeholder')}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 font-mono text-xs text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                    aria-label={t('newSession.directory')}
                />
                <button
                    type="button"
                    onClick={refresh}
                    disabled={!currentPath || isLoading}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-40"
                    title={t('directoryPicker.refresh')}
                    aria-label={t('directoryPicker.refresh')}
                >
                    <Refresh size={16} />
                </button>
            </div>

            {breadcrumbs.length > 1 ? (
                <div
                    ref={breadcrumbRef}
                    className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap pb-0.5 text-xs"
                >
                    {breadcrumbs.map((crumb, index) => (
                        <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                            {index > 0 ? <span className="text-[var(--app-hint)]">/</span> : null}
                            <button
                                type="button"
                                onClick={() => void loadDirectory(crumb.path)}
                                disabled={isLoading}
                                className={`rounded px-1 py-0.5 transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 ${
                                    index === breadcrumbs.length - 1
                                        ? 'font-medium text-[var(--app-fg)]'
                                        : 'text-[var(--app-hint)]'
                                }`}
                            >
                                {crumb.label}
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}

            {recentPaths.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-[var(--app-hint)]">
                        {t('directoryPicker.recent')}
                    </span>
                    <div className="flex gap-1 overflow-x-auto pb-0.5">
                        {recentPaths.map((path) => {
                            const isCurrent = currentPath !== null && normalizePath(path) === normalizePath(currentPath)
                            return (
                                <button
                                    key={path}
                                    type="button"
                                    onClick={() => navigateTo(path)}
                                    disabled={isLoading}
                                    className={`flex max-w-[13rem] shrink-0 flex-col items-start rounded-md border px-2 py-1 text-left transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 ${
                                        isCurrent
                                            ? 'border-[var(--app-link)] bg-[var(--app-secondary-bg)]'
                                            : 'border-transparent bg-[var(--app-subtle-bg)]'
                                    }`}
                                    title={path}
                                    aria-label={path}
                                >
                                    <span className="max-w-full truncate text-xs font-medium text-[var(--app-fg)]">
                                        {pathBasename(path)}
                                    </span>
                                    <span className="max-w-full truncate text-[10px] text-[var(--app-hint)]">
                                        {parentPath(path)}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                </div>
            ) : null}

            <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--app-hint)]">
                        <SearchIcon />
                    </span>
                    <input
                        ref={filterRef}
                        type="text"
                        value={filter}
                        onChange={(event) => {
                            setFilter(event.target.value)
                            setActiveIndex(-1)
                        }}
                        onKeyDown={handleFilterKeyDown}
                        placeholder={t('directoryPicker.filter')}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] pl-7 pr-7 text-xs text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        aria-label={t('directoryPicker.filter')}
                    />
                    {filter !== '' ? (
                        <button
                            type="button"
                            onClick={() => {
                                setFilter('')
                                setActiveIndex(-1)
                                filterRef.current?.focus()
                            }}
                            className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-sm text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                            aria-label={t('directoryPicker.clearFilter')}
                            title={t('directoryPicker.clearFilter')}
                        >
                            ×
                        </button>
                    ) : null}
                </div>
                {currentPath ? (
                    <span className="shrink-0 text-[10px] text-[var(--app-hint)]" aria-live="polite">
                        {t('directoryPicker.count', { count: directories.length })}
                    </span>
                ) : null}
            </div>

            <div
                ref={listRef}
                className="relative max-h-[34dvh] min-h-[7rem] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]"
            >
                {isLoading ? (
                    <div className="sticky top-0 z-10 h-0.5 animate-pulse bg-[var(--app-fg)]" aria-hidden="true" />
                ) : null}

                {isLoading && entries.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-[var(--app-hint)]">{t('directoryPicker.loading')}</p>
                ) : null}

                {error ? (
                    <div className="flex flex-col items-start gap-2 px-3 py-3 text-xs">
                        <p className="text-red-600">{error}</p>
                        <div className="flex flex-wrap items-center gap-1">
                            <button
                                type="button"
                                onClick={refresh}
                                className="rounded border border-[var(--app-border)] px-2 py-1 text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            >
                                {t('directoryPicker.refresh')}
                            </button>
                            {typedPath !== '' && parentPath(typedPath) !== typedPath ? (
                                <button
                                    type="button"
                                    onClick={() => void loadDirectory(parentPath(typedPath))}
                                    className="rounded border border-[var(--app-border)] px-2 py-1 text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                                >
                                    {t('directoryPicker.locateParent')}
                                </button>
                            ) : null}
                        </div>
                    </div>
                ) : null}

                {!error && !isLoading && rows.length === 0 ? (
                    <div className="flex flex-col items-start gap-2 px-3 py-4 text-xs text-[var(--app-hint)]">
                        <p>
                            {filter.trim() !== ''
                                ? t('directoryPicker.noMatch')
                                : currentPath
                                    ? t('directoryPicker.empty')
                                    : t('directoryPicker.typePath')}
                        </p>
                        {filter.trim() !== '' ? (
                            <button
                                type="button"
                                onClick={() => {
                                    setFilter('')
                                    setActiveIndex(-1)
                                    filterRef.current?.focus()
                                }}
                                className="rounded border border-[var(--app-border)] px-2 py-1 text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            >
                                {t('directoryPicker.clearFilter')}
                            </button>
                        ) : null}
                        {filter.trim() === '' && currentPath ? (
                            <p>{t('directoryPicker.emptyHint')}</p>
                        ) : null}
                    </div>
                ) : null}

                {!error && (!isLoading || entries.length > 0) ? (
                    <ul className={`divide-y divide-[var(--app-border)] ${isLoading ? 'opacity-60' : ''}`}>
                        {rows.map((row, index) => (
                            <li key={row.key}>
                                <button
                                    type="button"
                                    data-row-index={index}
                                    onClick={() => navigateTo(row.path)}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] ${
                                        index === activeIndex ? 'bg-[var(--app-secondary-bg)]' : ''
                                    }`}
                                    title={row.path}
                                >
                                    {row.isParent ? <ChevronUp size={16} /> : <Folder size={16} />}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate">
                                            {row.isParent ? t('directoryPicker.up') : row.label}
                                        </span>
                                        {row.isParent ? (
                                            <span className="block truncate text-[10px] text-[var(--app-hint)]">
                                                {row.path}
                                            </span>
                                        ) : null}
                                    </span>
                                    {row.isRecent ? (
                                        <span className="shrink-0 rounded bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                                            {t('directoryPicker.recentBadge')}
                                        </span>
                                    ) : null}
                                    {row.isGitRepo ? (
                                        <span className="shrink-0 rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">git</span>
                                    ) : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}

                {directories.length > MAX_VISIBLE_ENTRIES ? (
                    <p className="px-3 py-2 text-[10px] text-[var(--app-hint)]">
                        {t('directoryPicker.truncated', { count: MAX_VISIBLE_ENTRIES })}
                    </p>
                ) : null}
            </div>

            {props.statusMessage ? (
                <p className={`text-xs ${props.statusTone === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                    {props.statusMessage}
                </p>
            ) : null}

            <div className="sticky bottom-0 z-20 -mx-3 -mb-1 mt-1 flex flex-col gap-1.5 border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-1.5 pt-2">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="shrink-0 text-[var(--app-hint)]">{t('directoryPicker.willUse')}</span>
                        <span className="min-w-0 flex-1 truncate text-right font-mono text-[var(--app-fg)]" title={selectedPath ?? undefined}>
                            {selectedPath ? tailPath(selectedPath) : '—'}
                        </span>
                    </div>
                    {pathDiffersFromListed ? (
                        <p className="text-right text-[10px] text-[var(--app-hint)]">{t('directoryPicker.pressEnter')}</p>
                    ) : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                        <input
                            type="checkbox"
                            checked={showHidden}
                            onChange={toggleHidden}
                            className="h-3.5 w-3.5 accent-[var(--app-link)]"
                        />
                        {t('directoryPicker.hidden')}
                    </label>
                    <button
                        type="button"
                        onClick={confirmSelection}
                        disabled={!canSelect}
                        className="max-w-[70%] truncate rounded-md bg-[var(--app-fg)] px-3 py-1.5 text-sm font-medium text-[var(--app-bg)] transition-opacity disabled:opacity-40"
                        title={selectedPath ?? undefined}
                    >
                        {selectedPath ? t('directoryPicker.selectNamed', { name: pathBasename(selectedPath) }) : t('directoryPicker.select')}
                    </button>
                </div>
            </div>
        </div>
    )
}
