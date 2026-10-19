import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useTranslation } from '@/lib/use-translation'

function AddIcon() {
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

export function FileManagementToolbar(props: {
    busy: boolean
    showHidden: boolean
    exclude: readonly string[]
    onShowHidden: () => void
    onExclude: (patterns: string[]) => void
    onNewFile: () => void
    onNewFolder: () => void
    onUpload: () => void
    onUploadFolder: () => void
    onCollapse: () => void
}) {
    const { t } = useTranslation()
    const [filterOpen, setFilterOpen] = useState(false)
    const [pattern, setPattern] = useState(props.exclude.join(', '))
    useEffect(() => { if (filterOpen) setPattern(props.exclude.join(', ')) }, [filterOpen, props.exclude])
    const buttonClass = 'flex min-h-8 shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40'
    return <div role="toolbar" aria-label={t('files.manage.toolbar')} className="flex flex-wrap items-center gap-0.5 border-b border-[var(--app-divider)] px-2 py-1">
        <button type="button" disabled={props.busy} className={buttonClass} onClick={props.onNewFile}><AddIcon />{t('files.manage.newFile')}</button>
        <button type="button" disabled={props.busy} className={buttonClass} onClick={props.onNewFolder}><AddIcon />{t('files.manage.newFolder')}</button>
        <button type="button" disabled={props.busy} className={buttonClass} onClick={props.onUpload}>{t('files.manage.uploadFiles')}</button>
        <button type="button" disabled={props.busy} className={buttonClass} onClick={props.onUploadFolder}>{t('files.manage.uploadFolder')}</button>
        <span className="flex-1" />
        <button type="button" aria-pressed={props.showHidden} className={`${buttonClass} ${props.showHidden ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : ''}`} onClick={props.onShowHidden}>{t('files.manage.showHidden')}</button>
        <Popover.Root open={filterOpen} onOpenChange={setFilterOpen}>
            <Popover.Trigger asChild><button type="button" className={buttonClass}>{t('files.manage.filters')}{props.exclude.length ? ` (${props.exclude.length})` : ''}</button></Popover.Trigger>
            <Popover.Portal><Popover.Content className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-xl" sideOffset={6} align="end">
                <form onSubmit={event => { event.preventDefault(); props.onExclude(pattern.split(',').map(value => value.trim()).filter(Boolean).slice(0, 32)); setFilterOpen(false) }}>
                    <label className="block space-y-2 text-sm">
                        <span className="font-medium">{t('files.manage.exclude')}</span>
                        <input value={pattern} onChange={event => setPattern(event.target.value)} maxLength={8192} className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5" />
                    </label>
                    <p className="mt-2 text-xs text-[var(--app-hint)]">{t('files.manage.excludeHint')}</p>
                    <button type="submit" className="mt-3 rounded bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]">{t('files.manage.applyFilters')}</button>
                </form>
            </Popover.Content></Popover.Portal>
        </Popover.Root>
        <button type="button" className={buttonClass} onClick={props.onCollapse} title={t('files.manage.collapse')} aria-label={t('files.manage.collapse')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m7 8 5-5 5 5M7 16l5 5 5-5M4 12h16" /></svg>
        </button>
    </div>
}
