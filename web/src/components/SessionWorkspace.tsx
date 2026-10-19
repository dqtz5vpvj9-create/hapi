import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { useFileWorkbenchLabels } from '@/file-workbench/labels'
import './session-workspace.css'

export type WorkspaceView = 'terminal' | 'directories' | 'changes' | 'file'
export const WorkspacePanelContext = createContext(false)
export function useWorkspacePanel() { return useContext(WorkspacePanelContext) }

/** Keep the conversation mounted and measured while visiting its workspace. */
export function SessionWorkspace(props: {
    open: boolean
    view: WorkspaceView
    path?: string
    terminalAvailable: boolean
    filesAvailable: boolean
    onSelect: (view: Exclude<WorkspaceView, 'file'>) => void
    onClose: () => void
    chat: ReactNode
    panel: ReactNode
}) {
    const { t } = useTranslation()
    const fileLabels = useFileWorkbenchLabels()
    const rootRef = useRef<HTMLDivElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const returnFocusRef = useRef<HTMLElement | null>(null)
    const [split, setSplit] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [width, setWidth] = useState(() => {
        try { const value = Number(localStorage.getItem('hapi-file-workspace-width')); if (value >= 40 && value <= 90) return value } catch { /* Use the default width. */ }
        return 72
    })
    const fileView = props.view === 'directories' || props.view === 'file'
    const resizeCleanup = useRef<() => void>(() => {})
    useLayoutEffect(() => () => resizeCleanup.current(), [])
    const resizeWidth = (value: number) => {
        const next = Math.max(40, Math.min(90, value))
        setWidth(next)
        try { localStorage.setItem('hapi-file-workspace-width', String(next)) } catch { /* Resizing works without storage. */ }
    }
    const visitedChat = useRef(!props.open)
    if (!props.open) visitedChat.current = true
    useLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return
        const measure = () => setSplit(root.clientWidth >= 960)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(root)
        return () => observer.disconnect()
    }, [])
    useLayoutEffect(() => {
        if (!props.open) return
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        closeRef.current?.focus({ preventScroll: true })
        return () => { returnFocusRef.current?.focus({ preventScroll: true }) }
    }, [props.open])
    const chatCovered = props.open && (!split || expanded)
    const tabs = [
        { view: 'terminal' as const, label: t('session.workspace.terminal'), disabled: !props.terminalAvailable },
        { view: 'directories' as const, label: t('session.workspace.files'), disabled: !props.filesAvailable },
        { view: 'changes' as const, label: t('session.workspace.changes'), disabled: !props.filesAvailable },
    ]
    return (
        <div ref={rootRef} className="session-workspace" data-open={props.open} data-split={split && !expanded} style={{ '--session-panel-width': `${fileView ? width : 46}%` } as React.CSSProperties}>
            <div className="session-workspace-chat" inert={chatCovered} aria-hidden={chatCovered || undefined}>
                {visitedChat.current || split ? props.chat : null}
            </div>
            {props.open ? <>
                {split && !expanded && fileView ? <div className="session-workspace-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
                    aria-label={t('session.workspace.title')} aria-valuemin={40} aria-valuemax={90} aria-valuenow={width}
                    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeWidth(width + (event.key === 'ArrowLeft' ? 2 : -2)) } }}
                    onPointerDown={event => {
                        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
                        resizeCleanup.current()
                        const target = event.currentTarget, start = event.clientX, initial = width, available = rootRef.current?.clientWidth ?? 1
                        const move = (next: PointerEvent) => resizeWidth(initial + (start - next.clientX) * 100 / available)
                        const finish = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', finish) }
                        resizeCleanup.current = finish
                        target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', finish)
                    }} /> : null}
                <section className="session-workspace-panel" onKeyDown={event => event.stopPropagation()} aria-label={t('session.workspace.title')}>
                <header className="session-workspace-heading">
                    <button ref={closeRef} type="button" onClick={props.onClose} aria-label={t('session.workspace.close')} title={t('session.workspace.close')}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            {split ? <path d="m6 6 12 12M6 18 18 6" /> : <path d="m14 5-7 7 7 7" />}
                        </svg>
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">{t('session.workspace.title')}</div>
                        {props.path ? <div className="truncate text-xs text-[var(--app-hint)]" title={props.path}>{props.path}</div> : null}
                    </div>
                    {split && fileView ? <button type="button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? fileLabels.restore : fileLabels.expand} title={expanded ? fileLabels.restore : fileLabels.expand}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={expanded ? 'M9 3v6H3m18 6h-6v6M9 9 3 3m12 12 6 6' : 'M3 9V3h6m6 18h6v-6M3 3l6 6m6 6 6 6'} /></svg>
                    </button> : null}
                </header>
                <nav className="session-workspace-tabs" aria-label={t('session.workspace.title')}>
                    {tabs.map(tab => <button key={tab.view} type="button"
                        aria-current={props.view === tab.view ? 'page' : undefined}
                        disabled={tab.disabled}
                        onClick={() => props.onSelect(tab.view)}>{tab.label}</button>)}
                </nav>
                <WorkspacePanelContext.Provider value={true}>
                    <div className="session-workspace-content">{props.panel}</div>
                </WorkspacePanelContext.Provider>
            </section></> : null}
        </div>
    )
}
