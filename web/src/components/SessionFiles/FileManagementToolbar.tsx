import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import type { DirectorySort, DirectorySortDirection, DirectorySortField } from '@/lib/directory-sort'
import './file-browser.css'

function ToolbarIcon(props: { name: 'add' | 'more' | 'search' | 'refresh' | 'folder' | 'file' | 'upload' | 'sort' | 'filter' | 'collapse' | 'select' | 'back' | 'next' }) {
    const paths = {
        add: 'M12 5v14M5 12h14',
        more: '',
        search: 'm16 16 4 4',
        refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
        folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
        upload: 'M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4',
        sort: 'M3 6h13M3 12h9M3 18h5m9-3 3 3 3-3M20 18V6',
        filter: 'M4 7h16M7 12h10M10 17h4',
        collapse: 'm7 8 5-5 5 5M7 16l5 5 5-5M4 12h16',
        select: 'M9 11l2 2 4-4M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
        back: 'm14 6-6 6 6 6',
        next: 'm9 6 6 6-6 6',
    }
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={paths[props.name]} />
        {props.name === 'search' ? <circle cx="10.5" cy="10.5" r="6.5" /> : null}
        {props.name === 'more' ? <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></> : null}
    </svg>
}

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if ((event.target as HTMLElement).matches('input, textarea')) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
}

type SelectionActions = {
    count: number
    onCopyPaths: () => void
    onMove: () => void
    onCopy: () => void
    onDelete: () => void
    onDone: () => void
}

export function FileManagementToolbar(props: {
    busy: boolean
    foreground?: boolean
    canManage: boolean
    headerAction?: ReactNode
    query: string
    onQueryChange: (query: string) => void
    onRefresh: () => void
    sort: DirectorySort
    onSortChange: (sort: DirectorySort) => void
    showHidden: boolean
    exclude: readonly string[]
    onShowHidden: () => void
    onExclude: (patterns: string[]) => void
    onNewFile: () => void
    onNewFolder: () => void
    onUpload: () => void
    onUploadFolder: () => void
    onCollapse: () => void
    onStartSelection: () => void
    selection?: SelectionActions
}) {
    const { t } = useTranslation()
    const [createOpen, setCreateOpen] = useState(false)
    const [optionsOpen, setOptionsOpen] = useState(false)
    const [selectionOpen, setSelectionOpen] = useState(false)
    const [panel, setPanel] = useState<'options' | 'sort' | 'filters'>('options')
    const [pattern, setPattern] = useState(props.exclude.join(', '))
    const panelRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (props.foreground === false) { setCreateOpen(false); setOptionsOpen(false); setSelectionOpen(false) }
    }, [props.foreground])
    useEffect(() => { if (panel === 'filters') setPattern(props.exclude.join(', ')) }, [panel, props.exclude])
    useEffect(() => {
        if (optionsOpen) panelRef.current?.querySelector<HTMLElement>(panel === 'filters' ? 'input' : 'button')?.focus()
    }, [optionsOpen, panel])
    const choose = (close: (open: boolean) => void, action: () => void) => () => { close(false); action() }
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

    if (props.selection) {
        const selection = props.selection
        return <div className="file-browser-toolbar file-browser-selection" role="toolbar" aria-label={t('files.manage.selected', { count: selection.count })}>
            <span className="file-browser-selection-count" role="status">{selection.count ? t('files.manage.selected', { count: selection.count }) : t('files.manage.selectItems')}</span>
            <Popover.Root open={selectionOpen} onOpenChange={setSelectionOpen}>
                <Popover.Trigger asChild><button type="button" className="file-browser-control" aria-label={t('files.manage.selectionActions')} disabled={!selection.count}><ToolbarIcon name="more" /></button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="file-browser-menu" sideOffset={6} collisionPadding={8} align="end" role="menu" aria-label={t('files.manage.selectionActions')} onKeyDown={moveMenuFocus} onCloseAutoFocus={event => { if (props.foreground === false) event.preventDefault() }}>
                    <button type="button" role="menuitem" onClick={choose(setSelectionOpen, selection.onCopyPaths)}>{t('files.manage.copyPaths')}</button>
                    <div role="separator" />
                    <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setSelectionOpen, selection.onMove)}>{t('files.manage.moveSelected')}</button>
                    <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setSelectionOpen, selection.onCopy)}>{t('files.manage.copySelected')}</button>
                    <button type="button" role="menuitem" className="file-browser-danger" disabled={props.busy} onClick={choose(setSelectionOpen, selection.onDelete)}>{t('files.manage.deleteSelected')}</button>
                </Popover.Content></Popover.Portal>
            </Popover.Root>
            <button type="button" className="file-browser-control file-browser-done" onClick={selection.onDone}>{t('files.manage.doneSelecting')}</button>
        </div>
    }

    return <div className="file-browser-toolbar" role="toolbar" aria-label={t('files.manage.toolbar')}>
        {props.headerAction}
        <div className="file-browser-search">
            <ToolbarIcon name="search" />
            <input
                className="file-browser-search-input"
                value={props.query}
                onChange={event => props.onQueryChange(event.target.value)}
                placeholder={t('files.page.searchPlaceholder')}
                aria-label={t('files.page.searchPlaceholder')}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
            />
            {props.query ? <button type="button" className="file-browser-search-clear" aria-label={t('sessions.search.clear')} onClick={() => props.onQueryChange('')}><CloseIcon className="h-3.5 w-3.5" /></button> : null}
        </div>
        {props.canManage ? <Popover.Root open={createOpen} onOpenChange={setCreateOpen}>
            <Popover.Trigger asChild><button type="button" className="file-browser-control file-browser-create" disabled={props.busy}><ToolbarIcon name="add" /><span>{t('files.manage.add')}</span></button></Popover.Trigger>
            <Popover.Portal><Popover.Content className="file-browser-menu" sideOffset={6} collisionPadding={8} align="end" role="menu" aria-label={t('files.manage.add')} onKeyDown={moveMenuFocus} onCloseAutoFocus={event => { if (props.foreground === false) event.preventDefault() }}>
                <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setCreateOpen, props.onNewFile)}><ToolbarIcon name="file" />{t('files.manage.newFile')}</button>
                <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setCreateOpen, props.onNewFolder)}><ToolbarIcon name="folder" />{t('files.manage.newFolder')}</button>
                <div role="separator" />
                <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setCreateOpen, props.onUpload)}><ToolbarIcon name="upload" />{t('files.manage.uploadFiles')}</button>
                <button type="button" role="menuitem" disabled={props.busy} onClick={choose(setCreateOpen, props.onUploadFolder)}><ToolbarIcon name="folder" />{t('files.manage.uploadFolder')}</button>
            </Popover.Content></Popover.Portal>
        </Popover.Root> : null}
        <Popover.Root open={optionsOpen} onOpenChange={open => { setOptionsOpen(open); if (open) setPanel('options') }}>
            <Popover.Trigger asChild><button type="button" className="file-browser-control file-browser-options" aria-label={t('files.manage.browserOptions')} title={t('files.manage.browserOptions')}><ToolbarIcon name="more" />{props.exclude.length ? <span className="file-browser-filter-dot" /> : null}</button></Popover.Trigger>
            <Popover.Portal><Popover.Content ref={panelRef} className={`file-browser-menu ${panel === 'filters' ? 'file-browser-filter-menu' : ''}`} sideOffset={6} collisionPadding={8} align="end" role={panel === 'filters' ? 'dialog' : 'menu'} aria-label={t(panel === 'sort' ? 'files.sort.title' : panel === 'filters' ? 'files.manage.filters' : 'files.manage.browserOptions')} onKeyDown={moveMenuFocus} onCloseAutoFocus={event => { if (props.foreground === false) event.preventDefault() }}>
                {panel === 'options' ? <>
                    <button type="button" role="menuitem" onClick={choose(setOptionsOpen, props.onRefresh)}><ToolbarIcon name="refresh" />{t('files.page.refreshFilesystem')}</button>
                    {props.canManage || props.query ? <button type="button" role="menuitem" onClick={() => setPanel('sort')}><ToolbarIcon name="sort" />{t('files.sort.title')}<span className="file-browser-menu-tail"><ToolbarIcon name="next" /></span></button> : null}
                    {props.canManage ? <>
                        <button type="button" role="menuitemcheckbox" aria-checked={props.showHidden} onClick={props.onShowHidden}><span className="file-browser-check">{props.showHidden ? <CheckIcon className="h-4 w-4" /> : null}</span>{t('files.manage.showHidden')}</button>
                        <button type="button" role="menuitem" onClick={() => setPanel('filters')}><ToolbarIcon name="filter" />{t('files.manage.filters')}<span className="file-browser-menu-tail">{props.exclude.length || null}<ToolbarIcon name="next" /></span></button>
                        <button type="button" role="menuitem" onClick={choose(setOptionsOpen, props.onCollapse)}><ToolbarIcon name="collapse" />{t('files.manage.collapse')}</button>
                        <div role="separator" />
                        <button type="button" role="menuitem" onClick={choose(setOptionsOpen, props.onStartSelection)}><ToolbarIcon name="select" />{t('files.manage.selectItems')}</button>
                    </> : null}
                </> : <>
                    <button type="button" className="file-browser-menu-back" role={panel === 'sort' ? 'menuitem' : undefined} aria-label={t('files.manage.backToOptions')} onClick={() => setPanel('options')}><ToolbarIcon name="back" />{t(panel === 'sort' ? 'files.sort.title' : 'files.manage.filters')}</button>
                    <div role="separator" />
                    {panel === 'sort' ? <>
                        <div role="group" aria-label={t('files.sort.by')}>{fields.map(field => <button key={field.value} type="button" role="menuitemradio" aria-checked={props.sort.field === field.value} onClick={() => props.onSortChange({ ...props.sort, field: field.value })}><span className="file-browser-check">{props.sort.field === field.value ? <CheckIcon className="h-4 w-4" /> : null}</span>{field.label}</button>)}</div>
                        <div role="separator" />
                        <div role="group" aria-label={t('files.sort.direction')}>{directions.map(direction => <button key={direction.value} type="button" role="menuitemradio" aria-checked={props.sort.direction === direction.value} onClick={() => props.onSortChange({ ...props.sort, direction: direction.value })}><span className="file-browser-check">{props.sort.direction === direction.value ? <CheckIcon className="h-4 w-4" /> : null}</span>{direction.label}</button>)}</div>
                    </> : <form onSubmit={event => { event.preventDefault(); props.onExclude(pattern.split(',').map(value => value.trim()).filter(Boolean).slice(0, 32)); setOptionsOpen(false) }}>
                        <label><span>{t('files.manage.exclude')}</span><input value={pattern} onChange={event => setPattern(event.target.value)} maxLength={8192} /></label>
                        <p>{t('files.manage.excludeHint')}</p>
                        <button type="submit" className="file-browser-apply">{t('files.manage.applyFilters')}</button>
                    </form>}
                </>}
            </Popover.Content></Popover.Portal>
        </Popover.Root>
    </div>
}
