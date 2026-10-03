import { useCallback, useId } from 'react'
import { useGlassSurface } from '@/themes/glass/GlassScene'
import { useTranslation } from '@/lib/use-translation'
import { HoverTooltip } from '@/components/HoverTooltip'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { buildSessionReferenceText } from '@/lib/sessionReference'
import { usePlatform } from '@/hooks/usePlatform'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'
import { CopyIcon } from '@/components/icons'

type SessionActionMenuProps = {
    onOpenFiles?: () => void
    onOpenChanges?: () => void
    onOpenTerminal?: () => void
    terminalDisabledReason?: string
    onToggleTerminal?: () => void
    isOpen: boolean
    onClose: () => void
    sessionId: string
    sessionTitle: string
    sessionActive: boolean
    onRename: () => void
    sessionPinned?: boolean
    sessionGlobalPinned?: boolean
    onSetPinMode?: (mode: 'none' | 'project' | 'global') => void
    onExport?: () => void
    onMarkUnread?: () => void
    onSyncCodex?: () => void
    onSyncPi?: () => void
    onArchive: () => void
    onReopen?: () => void
    reopenDisabledReason?: string
    /** Soft-fail tip when reopen is allowed but chat-store probe could not verify. */
    reopenHint?: string
    onDelete: () => void
    anchorPoint: { x: number; y: number }
    menuId?: string
}

function EditIcon(props: { className?: string }) {
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
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
        </svg>
    )
}

function UnreadIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            className={props.className}
        >
            <circle cx="12" cy="12" r="4" fill="currentColor" />
        </svg>
    )
}

function PinIcon(props: { className?: string; filled?: boolean }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
            fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M12 17v5" />
            <path d="M5 17h14" />
            <path d="M7 4V2h10v2l-2 5v4l2 2H7l2-2V9Z" />
        </svg>
    )
}

function ArchiveIcon(props: { className?: string }) {
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
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
        </svg>
    )
}

function DownloadIcon(props: { className?: string }) {
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
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
    )
}

function ReopenIcon(props: { className?: string }) {
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
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
        </svg>
    )
}

function SyncIcon(props: { className?: string }) {
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
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
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
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        </svg>
    )
}

export function SessionActionMenu(props: SessionActionMenuProps) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const {
        isOpen,
        onClose,
        sessionId,
        sessionTitle,
        sessionActive,
        onRename,
        sessionPinned = false,
        sessionGlobalPinned = false,
        onSetPinMode,
        onExport,
        onMarkUnread,
        onSyncCodex,
        onSyncPi,
        onArchive,
        onReopen,
        reopenDisabledReason,
        reopenHint,
        onDelete,
        anchorPoint,
        menuId
    } = props
    const { menuRef, menuStyle } = useAnchoredMenu({ isOpen, onClose, anchorPoint })
    const glassRef = useGlassSurface<HTMLDivElement>()
    const panelRef = useCallback((element: HTMLDivElement | null) => {
        menuRef.current = element
        glassRef(element)
    }, [menuRef, glassRef])
    const internalId = useId()
    const resolvedMenuId = menuId ?? `session-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleRename = () => {
        onClose()
        onRename()
    }

    const handleCopyReference = async () => {
        onClose()
        try {
            await safeCopyToClipboard(buildSessionReferenceText(sessionTitle, sessionId))
            haptic.notification('success')
        } catch {
            haptic.notification('error')
        }
    }

    const handleSetPinMode = (mode: 'none' | 'project' | 'global') => {
        onClose()
        onSetPinMode?.(mode)
    }

    const handleArchive = () => {
        onClose()
        onArchive()
    }

    const handleReopen = () => {
        onClose()
        onReopen?.()
    }

    const handleExport = () => {
        onClose()
        onExport?.()
    }

    const handleMarkUnread = () => {
        onClose()
        onMarkUnread?.()
    }

    const handleSyncCodex = () => {
        onClose()
        onSyncCodex?.()
    }

    const handleSyncPi = () => {
        onClose()
        onSyncPi?.()
    }

    const handleDelete = () => {
        onClose()
        onDelete()
    }

    if (!isOpen) return null

    // The left text inset includes the icon and gap; mirror it on the right so
    // the text-to-border distance is symmetric without counting the icon twice.
    const baseItemClassName =
        'flex min-h-11 w-full items-center gap-3 rounded-md py-2 pl-3 pr-[42px] text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={panelRef}
            className="app-glass app-floating-panel fixed z-50 box-border w-max max-w-[calc(100vw-16px)] max-h-[calc(var(--app-viewport-height,100dvh)-16px)] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('session.more')}
            </div>
            <div
                id={resolvedMenuId}
                role="menu"
                aria-labelledby={headingId}
                className="flex flex-col gap-1"
            >
                {props.onOpenFiles || props.onOpenTerminal ? <div role="group" aria-label={t('session.workspace.title')}>
                    {props.onOpenTerminal ? <button type="button" role="menuitem"
                        aria-disabled={!!props.terminalDisabledReason}
                        className={`${baseItemClassName} min-h-11 hover:bg-[var(--app-subtle-bg)] ${props.terminalDisabledReason ? 'opacity-50' : ''}`}
                        onClick={props.terminalDisabledReason ? undefined : () => { onClose(); props.onOpenTerminal?.() }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>
                        <span>{t('session.workspace.terminal')}{props.terminalDisabledReason ? <span className="block text-xs text-[var(--app-hint)]">{props.terminalDisabledReason}</span> : null}</span>
                    </button> : null}
                    {props.onOpenFiles ? <button type="button" role="menuitem"
                        className={`${baseItemClassName} min-h-11 hover:bg-[var(--app-subtle-bg)]`}
                        onClick={() => { onClose(); props.onOpenFiles?.() }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
                        {t('session.workspace.files')}
                    </button> : null}
                    {props.onOpenChanges ? <button type="button" role="menuitem"
                        className={`${baseItemClassName} min-h-11 hover:bg-[var(--app-subtle-bg)]`}
                        onClick={() => { onClose(); props.onOpenChanges?.() }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h6M11 9v6M8 18h6" /></svg>
                        {t('session.workspace.changes')}
                    </button> : null}
                    {props.onToggleTerminal ? <button type="button" role="menuitem"
                        className={`${baseItemClassName} min-h-11 hover:bg-[var(--app-subtle-bg)]`}
                        onClick={() => { onClose(); props.onToggleTerminal?.() }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 6 6 6-6 6m9 0h7" /></svg>
                        {t('session.workspace.agentTerminal')}
                    </button> : null}
                    <div role="separator" className="my-1 h-px bg-[var(--app-divider)]" />
                </div> : null}
                <button
                    type="button"
                    role="menuitem"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={handleRename}
                >
                    <EditIcon className="text-[var(--app-hint)]" />
                    {t('session.action.rename')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={() => void handleCopyReference()}
                >
                    <CopyIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('session.action.copyReference')}
                </button>

                {onMarkUnread ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleMarkUnread}
                    >
                        <UnreadIcon className="text-[var(--app-hint)]" />
                        {t('session.action.markUnread')}
                    </button>
                ) : null}

                {onSetPinMode ? (
                    <>
                        <button
                            type="button"
                            role="menuitem"
                            className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                            onClick={() => handleSetPinMode(sessionPinned ? 'none' : 'project')}
                        >
                            <PinIcon filled={sessionPinned} className="text-[var(--app-hint)]" />
                            {t(sessionPinned ? 'session.action.unpinProject' : 'session.action.pinProject')}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                            onClick={() => handleSetPinMode(sessionGlobalPinned ? 'none' : 'global')}
                        >
                            <PinIcon filled={sessionGlobalPinned} className="text-[var(--app-hint)]" />
                            {t(sessionGlobalPinned ? 'session.action.unpinGlobal' : 'session.action.pinGlobal')}
                        </button>
                    </>
                ) : null}

                {onExport ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleExport}
                    >
                        <DownloadIcon className="text-[var(--app-hint)]" />
                        {t('session.action.export')}
                    </button>
                ) : null}

                {onSyncCodex ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleSyncCodex}
                    >
                        <SyncIcon className="text-[var(--app-hint)]" />
                        {t('session.action.syncCodex')}
                    </button>
                ) : null}

                {onSyncPi ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleSyncPi}
                    >
                        <SyncIcon className="text-[var(--app-hint)]" />
                        {t('session.action.syncPi')}
                    </button>
                ) : null}

                <div role="separator" className="my-1 h-px bg-[var(--app-divider)]" />
                {sessionActive ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                        onClick={handleArchive}
                    >
                        <ArchiveIcon className="text-red-500" />
                        {t('session.action.archive')}
                    </button>
                ) : (
                    <>
                        {onReopen || reopenDisabledReason || reopenHint ? (
                            <HoverTooltip
                                id={`${resolvedMenuId}-reopen-tooltip`}
                                className="w-full [&>span:first-child]:w-full"
                                align="start"
                                revealOnParentFocusClass="group-focus-within:opacity-100 group-focus-within:visible"
                                target={(
                                    <button
                                        type="button"
                                        role="menuitem"
                                        aria-disabled={reopenDisabledReason ? true : undefined}
                                        aria-describedby={
                                            reopenDisabledReason || reopenHint
                                                ? `${resolvedMenuId}-reopen-tooltip`
                                                : undefined
                                        }
                                        className={`${baseItemClassName} ${reopenDisabledReason
                                            ? 'cursor-not-allowed opacity-50'
                                            : 'hover:bg-[var(--app-subtle-bg)]'}`}
                                        onClick={reopenDisabledReason ? undefined : handleReopen}
                                    >
                                        <ReopenIcon className="text-[var(--app-hint)]" />
                                        {t('session.action.reopen')}
                                    </button>
                                )}
                            >
                                {reopenDisabledReason ?? reopenHint ?? t('session.action.reopen')}
                            </HoverTooltip>
                        ) : null}
                        <button
                            type="button"
                            role="menuitem"
                            className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                            onClick={handleDelete}
                        >
                            <TrashIcon className="text-red-500" />
                            {t('session.action.delete')}
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
