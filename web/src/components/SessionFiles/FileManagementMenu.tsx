import { createPortal } from 'react-dom'
import { useId } from 'react'
import { useAnchoredMenu, type AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'
import { useTranslation } from '@/lib/use-translation'
import type { FileManagerAction, FileManagerTarget } from './file-manager-types'

export type FileManagementMenuState = { target: FileManagerTarget; point: AnchoredMenuPoint }

export function FileManagementMenu(props: {
    menu: FileManagementMenuState | null
    busy: boolean
    onClose: () => void
    onAction: (action: FileManagerAction, target: FileManagerTarget) => void
    onOpen: (target: FileManagerTarget) => void
    onReveal: (target: FileManagerTarget) => void
    onDownload: (target: FileManagerTarget) => void
    onUpload: (target: FileManagerTarget) => void
    onCopyPath: (absolute: boolean, target: FileManagerTarget) => void
    onReference: (target: FileManagerTarget) => void
}) {
    const { t } = useTranslation()
    const titleId = useId()
    const { menuRef, menuStyle } = useAnchoredMenu({ isOpen: props.menu !== null, onClose: props.onClose, anchorPoint: props.menu?.point ?? { x: 0, y: 0 }, align: 'start' })
    const target = props.menu?.target
    if (!target) return null
    const choose = (action: () => void) => () => { props.onClose(); action() }
    const itemClass = 'w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus:bg-[var(--app-subtle-bg)] focus:outline-none disabled:opacity-40'
    const mutationItem = (action: FileManagerAction, label: string) => <button key={action} type="button" role="menuitem" disabled={props.busy} className={`${itemClass} ${action === 'delete' ? 'text-red-600 dark:text-red-400' : ''}`} onClick={choose(() => props.onAction(action, target))}>{label}</button>
    return createPortal(
        <div ref={menuRef} style={menuStyle} className="fixed z-[60] min-w-52 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl">
            <div id={titleId} className="max-w-72 truncate px-3 py-2 text-xs font-medium text-[var(--app-hint)]" title={target.path}>{target.path || t('files.manage.root')}</div>
            <div role="menu" aria-labelledby={titleId} onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                items[next]?.focus()
            }}>
                {target.kind === 'file' ? <>
                    <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onOpen(target))}>{t('files.manage.open')}</button>
                    <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onDownload(target))}>{t('files.manage.download')}</button>
                </> : null}
                {target.path ? <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onReveal(target))}>{t('files.manage.reveal')}</button> : null}
                {target.kind === 'directory' ? <>
                    {mutationItem('create-file', t('files.manage.newFile'))}
                    {mutationItem('create-directory', t('files.manage.newFolder'))}
                    <button type="button" role="menuitem" disabled={props.busy} className={itemClass} onClick={choose(() => props.onUpload(target))}>{t('files.manage.uploadHere')}</button>
                </> : null}
                <div role="separator" className="my-1 border-t border-[var(--app-divider)]" />
                <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onCopyPath(false, target))}>{t('file.menu.copyPath')}</button>
                <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onCopyPath(true, target))}>{t('file.menu.copyAbsolutePath')}</button>
                <button type="button" role="menuitem" className={itemClass} onClick={choose(() => props.onReference(target))}>{t('file.menu.addToComposer')}</button>
                {target.path ? <>
                    <div role="separator" className="my-1 border-t border-[var(--app-divider)]" />
                    {mutationItem('rename', t('files.manage.rename'))}
                    {mutationItem('move', t('files.manage.moveMenu'))}
                    {mutationItem('copy', t('files.manage.copyMenu'))}
                    {mutationItem('delete', t('files.manage.delete'))}
                </> : null}
            </div>
        </div>, document.body,
    )
}
