import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'
import './session-workspace.css'

export type WorkspaceView = 'terminal' | 'directories' | 'changes' | 'file'
const WorkspacePanelContext = createContext(false)
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
    const rootRef = useRef<HTMLDivElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const returnFocusRef = useRef<HTMLElement | null>(null)
    const [split, setSplit] = useState(false)
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
    const chatCovered = props.open && !split
    const tabs = [
        { view: 'terminal' as const, label: t('session.workspace.terminal'), disabled: !props.terminalAvailable },
        { view: 'directories' as const, label: t('session.workspace.files'), disabled: !props.filesAvailable },
        { view: 'changes' as const, label: t('session.workspace.changes'), disabled: !props.filesAvailable },
    ]
    return (
        <div ref={rootRef} className="session-workspace" data-open={props.open} data-split={split}>
            <div className="session-workspace-chat" inert={chatCovered} aria-hidden={chatCovered || undefined}>
                {visitedChat.current || split ? props.chat : null}
            </div>
            {props.open ? <section className="session-workspace-panel" onKeyDown={event => event.stopPropagation()} aria-label={t('session.workspace.title')}>
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
            </section> : null}
        </div>
    )
}
