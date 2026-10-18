import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'
import { useFileMenuTrigger } from '@/hooks/useFileMenuTrigger'
import type { AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'
import { formatDirectoryError } from '@/lib/files-i18n'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import { downloadBase64File } from '@/lib/file-download'
import { formatFileMetadata } from '@/lib/file-metadata'
import { sortDirectoryEntries, type DirectorySort } from '@/lib/directory-sort'
import { normalizeFileManagerTarget } from '@/lib/session-files-navigation'
import { fileManagerContains, fileManagerJoin, matchesFileManagerExclude } from './file-manager-paths'
import type { FileManagerTarget } from './file-manager-types'

type FileMenuRequestHandler = (path: string, point: AnchoredMenuPoint) => void
type EntryMenuRequestHandler = (target: FileManagerTarget, point: AnchoredMenuPoint) => void

function ChevronIcon(props: { collapsed: boolean }) {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 text-[var(--app-hint)] transition-transform ${props.collapsed ? '' : 'rotate-90'}`} aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
}

function FolderIcon() {
    return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-[var(--app-link)]" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
}

function DownloadIcon() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
}

function DirectorySkeleton(props: { depth: number }) {
    return <div className="animate-pulse">{Array.from({ length: 4 }, (_, index) => <div key={index} className="flex items-center gap-3 py-2" style={{ paddingLeft: 12 + props.depth * 14 }}><div className="h-5 w-5 rounded bg-[var(--app-subtle-bg)]" /><div className="h-3 w-40 rounded bg-[var(--app-subtle-bg)]" /></div>)}</div>
}

function RowMenuButton(props: { name: string; onOpen: (point: AnchoredMenuPoint) => void }) {
    const { t } = useTranslation()
    return <button type="button" className="app-file-icon-action flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]" aria-label={t('files.manage.actions', { name: props.name })} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); props.onOpen({ x: rect.right, y: rect.bottom }) }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    </button>
}

function SelectionBox(props: { name: string; selected: boolean; onToggle: () => void }) {
    const { t } = useTranslation()
    return <input type="checkbox" checked={props.selected} onChange={props.onToggle} aria-label={t('files.manage.select', { name: props.name })} className="h-3.5 w-3.5 shrink-0 accent-[var(--app-link)]" />
}

type TreeOptions = {
    api: ApiClient | null
    sessionId: string
    onOpenFile: (path: string) => void
    onRequestFileMenu?: FileMenuRequestHandler
    onRequestEntryMenu?: EntryMenuRequestHandler
    onRequestDownload?: (target: FileManagerTarget) => void
    onDropFiles?: (data: DataTransfer, directory: string) => void
    sort: DirectorySort
    target?: string
    activeFilePath?: string
    revealKey?: string | number
    caseInsensitive: boolean
    showHidden: boolean
    exclude: readonly string[]
    foreground: boolean
    expanded: Set<string>
    onToggle: (path: string) => void
    selectedPaths?: ReadonlySet<string>
    onSelect?: (path: string, range: boolean) => void
}

function menuFor(options: TreeOptions, target: FileManagerTarget): ((point: AnchoredMenuPoint) => void) | undefined {
    if (options.onRequestEntryMenu) return point => options.onRequestEntryMenu!(target, point)
    if (target.kind === 'file' && options.onRequestFileMenu) return point => options.onRequestFileMenu!(target.path, point)
    return undefined
}

function selectWithModifier(event: MouseEvent, options: TreeOptions, path: string): void {
    if (!options.onSelect || (!event.ctrlKey && !event.metaKey && !event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    options.onSelect(path, event.shiftKey)
}

function DirectoryFileRow(props: {
    target: FileManagerTarget
    metadata: string | null
    depth: number
    options: TreeOptions
    downloading: boolean
    downloadDisabled: boolean
    onDownload: () => void
}) {
    const { t } = useTranslation()
    const { target, options } = props
    const row = useRef<HTMLDivElement>(null)
    const compare = (path: string) => options.caseInsensitive ? path.toLowerCase() : path
    const current = compare(options.activeFilePath ?? options.target ?? '') === compare(target.path)
    const revealed = options.target !== undefined && compare(options.target) === compare(target.path)
    useEffect(() => { if (revealed && options.foreground) row.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [revealed, options.revealKey, options.foreground])
    const openMenu = menuFor(options, target)
    const handlers = useFileMenuTrigger({ onOpen: () => { if (target.kind === 'file') options.onOpenFile(target.path) }, onOpenMenu: openMenu })
    const selected = options.selectedPaths?.has(target.path) ?? false
    return <div
        ref={row} role="treeitem" aria-selected={selected} aria-level={props.depth + 1}
        data-file-path={target.path} data-file-kind={target.kind} data-file-target={revealed || undefined}
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--app-subtle-bg)] ${current ? 'bg-[var(--app-subtle-bg)] ring-1 ring-inset ring-[var(--app-link)]' : selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
        style={{ paddingLeft: 12 + props.depth * 14 }}
    >
        {options.onSelect ? <SelectionBox name={target.name} selected={selected} onToggle={() => options.onSelect!(target.path, false)} /> : <span className="h-4 w-4" />}
        <FileIcon fileName={target.name} size={22} />
        <button type="button" {...handlers} onClickCapture={event => selectWithModifier(event, options, target.path)} aria-current={current ? 'true' : undefined} aria-disabled={target.kind === 'symlink' || undefined} title={target.path} className="app-file-tree-target min-w-0 flex-1 text-left">
            <div className="truncate font-medium">{target.name}</div>
            {target.kind === 'symlink' ? <div className="truncate text-xs text-[var(--app-hint)]" title={t('files.manage.symbolicLinkHint')}>{t('files.manage.symbolicLink')}</div>
                : props.metadata ? <div className="truncate text-xs text-[var(--app-hint)]">{props.metadata}</div> : null}
        </button>
        {target.kind === 'file' ? <button type="button" onClick={props.onDownload} disabled={props.downloadDisabled} className={`app-file-icon-action flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-40 ${props.downloading ? 'animate-pulse' : ''}`} title={t('files.directories.download')} aria-label={t('files.directories.downloadNamed', { name: target.name })}><DownloadIcon /></button> : null}
        {openMenu ? <RowMenuButton name={target.name} onOpen={openMenu} /> : null}
    </div>
}

function DirectoryNode(props: { path: string; label: string; depth: number; options: TreeOptions }) {
    const { t, locale } = useTranslation()
    const toast = useToast()
    const { options, path } = props
    const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
    const [dropActive, setDropActive] = useState(false)
    const compare = (value: string) => options.caseInsensitive ? value.toLowerCase() : value
    const isExpanded = options.expanded.has(compare(path))
    const { entries, error, isLoading } = useSessionDirectory(options.api, options.sessionId, path, { enabled: isExpanded && options.foreground })
    const visibleEntries = useMemo(() => sortDirectoryEntries(entries.filter(entry => {
        const child = fileManagerJoin(path, entry.name)
        // A direct reveal may bypass preferences; it never widens filesystem access.
        if (options.target && fileManagerContains(child, options.target, options.caseInsensitive)) return true
        return (options.showHidden || !entry.name.startsWith('.')) && !matchesFileManagerExclude(child, options.exclude)
    }), options.sort, locale), [entries, locale, options.caseInsensitive, options.exclude, options.showHidden, options.sort, options.target, path])
    const childDepth = props.depth + 1
    const targetRest = options.target && (path === '' ? options.target : compare(options.target).startsWith(`${compare(path)}/`) ? options.target.slice(path.length + 1) : undefined)
    const targetParts = targetRest?.split('/')
    const targetEntry = targetParts ? entries.find(entry => compare(entry.name) === compare(targetParts[0]!)) : undefined
    const targetUnavailable = targetParts && !isLoading && !error && options.foreground
        && (!targetEntry || targetEntry.type !== (targetParts.length > 1 ? 'directory' : 'file'))
    const target: FileManagerTarget = { path, name: props.label, kind: 'directory' }
    const openMenu = menuFor(options, target)
    const handlers = useFileMenuTrigger({ onOpen: () => options.onToggle(path), onOpenMenu: openMenu })

    const download = async (filePath: string, name: string) => {
        if (options.onRequestDownload) { options.onRequestDownload({ path: filePath, name, kind: 'file' }); return }
        if (!options.api || downloadingPath) return
        setDownloadingPath(filePath)
        try {
            const response = await options.api.readSessionFile(options.sessionId, filePath)
            if (!response.success || response.content === undefined) throw new Error(response.error ?? t('files.directories.download.error.default'))
            downloadBase64File(name, response.content)
        } catch (cause) {
            toast.addToast({ title: t('files.directories.download.error.title'), body: cause instanceof Error ? cause.message : t('files.directories.download.error.default'), sessionId: options.sessionId, url: `/sessions/${options.sessionId}/files?tab=directories` })
        } finally { setDownloadingPath(null) }
    }
    const drag = (event: DragEvent) => {
        if (!options.onDropFiles || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault(); event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        setDropActive(true)
    }

    return <div role="treeitem" aria-expanded={isExpanded} aria-level={props.depth + 1}>
        <div
            data-file-path={path} data-file-kind="directory"
            className={`flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--app-subtle-bg)] ${dropActive ? 'bg-[var(--app-subtle-bg)] ring-1 ring-inset ring-[var(--app-link)]' : ''}`}
            style={{ paddingLeft: 12 + props.depth * 14 }}
            onDragEnter={drag} onDragOver={drag} onDragLeave={() => setDropActive(false)}
            onDrop={event => {
                if (!options.onDropFiles || !event.dataTransfer.types.includes('Files')) return
                event.preventDefault(); event.stopPropagation(); setDropActive(false)
                options.onDropFiles(event.dataTransfer, path)
            }}
        >
            {options.onSelect && path ? <SelectionBox name={props.label} selected={options.selectedPaths?.has(path) ?? false} onToggle={() => options.onSelect!(path, false)} /> : null}
            <button type="button" {...handlers} aria-expanded={isExpanded} onClickCapture={event => { if (path) selectWithModifier(event, options, path) }} title={path || props.label} className="app-file-tree-target flex min-w-0 flex-1 items-center gap-2 text-left">
                <ChevronIcon collapsed={!isExpanded} /><FolderIcon /><span className="truncate font-medium">{props.label}</span>
            </button>
            {openMenu ? <RowMenuButton name={props.label} onOpen={openMenu} /> : null}
        </div>
        {isExpanded ? isLoading ? <DirectorySkeleton depth={childDepth} />
            : error ? <div role="alert" className="bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]" style={{ paddingLeft: 12 + childDepth * 14 }}>{formatDirectoryError(error, t)}</div>
            : <div role="group">
                {visibleEntries.map(entry => {
                    const childPath = fileManagerJoin(path, entry.name)
                    if (entry.type === 'directory') return <DirectoryNode key={childPath} path={childPath} label={entry.name} depth={childDepth} options={options} />
                    if (entry.type !== 'file' && !entry.isSymbolicLink) return null
                    return <DirectoryFileRow key={childPath} target={{ path: childPath, name: entry.name, kind: entry.isSymbolicLink ? 'symlink' : 'file' }} metadata={formatFileMetadata(entry.size, entry.modified, locale)} depth={childDepth} options={options} downloading={downloadingPath === childPath} downloadDisabled={Boolean(downloadingPath)} onDownload={() => void download(childPath, entry.name)} />
                })}
                {targetUnavailable ? <div role="alert" className="px-3 py-2 text-sm text-[var(--app-hint)]" style={{ paddingLeft: 12 + childDepth * 14 }}>{t('files.directories.targetUnavailable', { path: options.target! })}</div> : null}
                {visibleEntries.length === 0 ? <div className="px-3 py-2 text-sm text-[var(--app-hint)]" style={{ paddingLeft: 12 + childDepth * 14 }}>{t(entries.length ? 'files.manage.filteredEmpty' : 'files.directories.empty')}</div> : null}
            </div> : null}
    </div>
}

const STORAGE_KEY_PREFIX = 'hapi-dir-expanded-'
const EMPTY_PATTERNS: readonly string[] = []

function readExpanded(key: string): Set<string> {
    try {
        const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY_PREFIX + key) ?? 'null')
        if (Array.isArray(parsed)) return new Set(parsed.slice(0, 2000).filter((path): path is string => typeof path === 'string' && (path === '' || normalizeFileManagerTarget(path) === path)))
    } catch { /* Browser storage is optional. */ }
    return new Set([''])
}

export function DirectoryTree(props: {
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    onOpenFile: (path: string) => void
    onRequestFileMenu?: FileMenuRequestHandler
    onRequestEntryMenu?: EntryMenuRequestHandler
    onRequestDownload?: (target: FileManagerTarget) => void
    onDropFiles?: (data: DataTransfer, directory: string) => void
    sort: DirectorySort
    target?: string
    activeFilePath?: string
    revealDirectory?: { path: string; key: number }
    revealKey?: string | number
    collapseKey?: number
    caseInsensitive?: boolean
    showHidden?: boolean
    exclude?: readonly string[]
    foreground?: boolean
    selectedPaths?: ReadonlySet<string>
    onSelectedPathsChange?: (paths: Set<string>) => void
}) {
    const target = normalizeFileManagerTarget(props.target)
    const caseInsensitive = props.caseInsensitive === true
    const treeRef = useRef<HTMLDivElement>(null)
    const anchor = useRef<string | null>(null)
    const scope = props.api?.getForkOperationScope?.()
    const storageKey = scope ? `${scope}:${props.sessionId}` : props.sessionId
    const revealTarget = useCallback((previous: Set<string>) => {
        const next = new Set([...previous].map(path => caseInsensitive ? path.toLowerCase() : path))
        const reveal = (path: string, includeSelf: boolean) => {
            const parts = path.split('/')
            for (let index = 0; index < parts.length + (includeSelf ? 1 : 0); index++) {
                const parent = parts.slice(0, index).join('/')
                next.add(caseInsensitive ? parent.toLowerCase() : parent)
            }
        }
        if (target) reveal(target, false)
        if (props.revealDirectory) reveal(props.revealDirectory.path, true)
        return next
    }, [caseInsensitive, props.revealDirectory, target])
    const [state, setState] = useState(() => ({ storageKey, expanded: revealTarget(readExpanded(storageKey)) }))
    const expanded = state.storageKey === storageKey ? state.expanded : revealTarget(readExpanded(storageKey))
    useEffect(() => { setState(previous => ({ storageKey, expanded: revealTarget(previous.storageKey === storageKey ? previous.expanded : readExpanded(storageKey)) })) }, [revealTarget, props.revealKey, storageKey])
    useEffect(() => {
        if (state.storageKey !== storageKey) return
        try { sessionStorage.setItem(STORAGE_KEY_PREFIX + storageKey, JSON.stringify([...state.expanded].slice(0, 2000))) } catch { /* Storage limits do not block navigation. */ }
    }, [state, storageKey])
    const previousCollapse = useRef(props.collapseKey)
    useEffect(() => {
        if (previousCollapse.current === props.collapseKey) return
        previousCollapse.current = props.collapseKey
        setState({ storageKey, expanded: new Set(['']) })
    }, [props.collapseKey, storageKey])
    const toggle = useCallback((path: string) => {
        const key = caseInsensitive ? path.toLowerCase() : path
        setState(previous => {
            const next = new Set(previous.storageKey === storageKey ? previous.expanded : readExpanded(storageKey))
            if (next.has(key)) next.delete(key); else next.add(key)
            return { storageKey, expanded: next }
        })
    }, [caseInsensitive, storageKey])
    const select = useCallback((path: string, range: boolean) => {
        if (!props.onSelectedPathsChange) return
        const next = new Set(props.selectedPaths)
        const visible = [...treeRef.current?.querySelectorAll<HTMLElement>('[data-file-path][data-file-kind]') ?? []].map(row => row.dataset.filePath!).filter(Boolean)
        const start = range && anchor.current ? visible.indexOf(anchor.current) : -1
        const end = visible.indexOf(path)
        if (start >= 0 && end >= 0) for (const value of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(value)
        else { if (next.has(path)) next.delete(path); else next.add(path); anchor.current = path }
        props.onSelectedPathsChange(next)
    }, [props.onSelectedPathsChange, props.selectedPaths])

    const options: TreeOptions = { ...props, target, activeFilePath: normalizeFileManagerTarget(props.activeFilePath), caseInsensitive, expanded, onToggle: toggle, onSelect: props.onSelectedPathsChange ? select : undefined, showHidden: props.showHidden ?? true, exclude: props.exclude ?? EMPTY_PATTERNS, foreground: props.foreground !== false }
    return <div ref={treeRef} role="tree" aria-label={props.rootLabel} aria-multiselectable={Boolean(props.onSelectedPathsChange)} className="border-t border-[var(--app-divider)]">
        <DirectoryNode path="" label={props.rootLabel} depth={0} options={options} />
    </div>
}
