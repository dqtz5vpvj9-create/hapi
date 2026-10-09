import { DocumentLeaveDialog } from '@/documents/DocumentLeaveDialog'
import { documentName } from '@hapi/protocol/documents'
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { Actions, DockLocation, Layout, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { MachineIdentityIcon, MachineIdentityProvider } from '@/components/MachineIdentityIcon'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SessionSummary } from '@/types/api'
import { WorkspaceActivity } from './WorkspaceActivity'
import { WorkspacePaneActions } from './WorkspacePaneActions'
import { WorkspaceIcon } from './WorkspaceIcon'
import { WorkspacePane } from './WorkspacePane'
import { panes, type PaneNode, type WorkspaceNode, type WorkspaceDocument, type WorkspaceStore } from './workspaceStore'
import { workspaceModel, workspaceTree } from './layoutAdapter'
import 'flexlayout-react/style/light.css'
import './workspace.css'

export function WorkspaceShell() {
    const { api, workspace: store } = useAppContext()
    const { sessions } = useSessions(api)
    const { machines } = useMachines(api, true)
    const labels = useMachineLabels(machines)
    const title = useCallback((id: string) => { const session = sessions.find(s => s.id === id); return session ? getSessionTitle(session) : id.slice(0, 8) }, [sessions])
    const navigate = useNavigate()
    // Direct links must select workspace mode just like the view-mode button.
    useEffect(() => { store?.enter() }, [store])
    const pickSession = useCallback(() => {
        const sidebar = document.querySelector<HTMLElement>('.app-session-sidebar-frame')
        if (sidebar && sidebar.getBoundingClientRect().width > 0) {
            const search = sidebar.querySelector<HTMLInputElement>('input[type="search"]')
            if (search) search.focus()
            else sidebar.querySelector<HTMLButtonElement>('.app-session-search-trigger')?.click()
            return
        }
        store?.capture()
        void navigate({ to: '/sessions', search: { view: 'list' }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
    }, [store, navigate])
    if (!store) return null
    return <MachineIdentityProvider machines={Object.fromEntries(machines.map(m => [m.id, m]))} labels={labels}>
        <DocumentLeaveDialog store={store} />
        <WorkspaceSurface sessions={sessions} store={store} title={title}
            onPick={pickSession} onSingle={() => { const id = store.leave(); void navigate(id ? { to: '/sessions/$sessionId', params: { sessionId: id } } : { to: '/sessions' }) }} />
    </MachineIdentityProvider>
}

type PaneProps = { pane: PaneNode; focused: boolean; foreground?: boolean; store: WorkspaceStore; pickSession: () => void }
const WorkspaceForeground = createContext(true)

// Budget mounted readers rather than workspaces: a single-pane workspace should
// not cost the same as a four-pane one. Keep the immediate predecessor even when
// it is large, so alternating two working layouts never becomes a cold restore.
function retainWorkspaceViews(state: ReturnType<WorkspaceStore['get']>, recent: string[]): string[] {
    const ordered = [state.activeId, ...recent.filter(id => id !== state.activeId)]
        .filter((id): id is string => !!id && state.workspaces.some(w => w.id === id))
    let remaining = 4
    const retained: string[] = []
    for (const id of ordered) {
        const workspace = state.workspaces.find(w => w.id === id)!
        // Phone/zoom hides readers without discarding them. Reserve the whole
        // layout's cost so opening its panes cannot exceed the retained budget.
        const cost = panes(workspace.root).length
        if (retained.length > 1 && cost > remaining) break
        if (retained.length > 0) remaining -= cost
        retained.push(id)
    }
    return retained
}

export function WorkspaceSurface(props: { sessions?: SessionSummary[]; store: WorkspaceStore; title: (id: string) => string; onPick: () => void; onSingle: () => void; renderPane?: ComponentType<PaneProps> }) {
    const { store } = props
    const state = useSyncExternalStore(store.subscribe, store.get)
    const { t } = useTranslation()
    const mobile = useNarrowViewport()
    const active = state.workspaces.find(w => w.id === state.activeId)
    const allPanes = useMemo(() => active ? panes(active.root) : [], [active?.root])
    const focused = active ? state.focused[active.id] : null
    const [recentIds, setRecentIds] = useState<string[]>(() => active ? [active.id] : [])
    const nextRecentIds = retainWorkspaceViews(state, recentIds)
    if (recentIds.length !== nextRecentIds.length || recentIds.some((id, index) => id !== nextRecentIds[index])) {
        setRecentIds(nextRecentIds)
    }
    const retainedIds = new Set(nextRecentIds)
    const retained = state.workspaces.filter(w => retainedIds.has(w.id))
    const root = useRef<HTMLDivElement>(null)
    const models = useRef(new Map<string, Model>())
    const lastWheel = useRef(0)
    const wheelAmount = useRef(0)
    const [switcherOpen, setSwitcherOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [closedNotice, setClosedNotice] = useState(false)
    useEffect(() => { if (!closedNotice) return; const timer = setTimeout(() => setClosedNotice(false), 6000); return () => clearTimeout(timer) }, [closedNotice])
    const closeWorkspace = (id: string) => { store.closeWorkspace(id); setClosedNotice(true); setMenuOpen(false) }
    const split = useCallback((axis: 'horizontal' | 'vertical') => { store.split(axis); props.onPick() }, [store, props.onPick])
    const createWindow = useCallback(() => {
        store.create(t('workspace.defaultName', { number: store.get().workspaces.length + 1 }))
        props.onPick()
    }, [store, t, props.onPick])
    const moveToNewWindow = useCallback((paneId: string) => {
        store.create(t('workspace.defaultName', { number: store.get().workspaces.length + 1 }))
        store.movePane(paneId, store.active()!.id)
    }, [store, t])
    const sessionFor = (pane?: PaneNode) => { const resource = pane?.resource; return resource?.kind === 'chat' ? props.sessions?.find(s => s.id === resource.sessionId) : undefined }
    const focusedNode = allPanes.find(p => p.id === focused)
    const bottom = useRef<HTMLElement>(null)
    const paneTabs = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        const list = paneTabs.current
        const selected = list?.querySelector<HTMLElement>('[aria-pressed="true"]')
        if (!list || !selected) return
        const bounds = list.getBoundingClientRect(), tab = selected.getBoundingClientRect()
        // Scroll this strip only; focusing a pane must not move its chat history.
        if (tab.left < bounds.left) list.scrollLeft += tab.left - bounds.left
        else if (tab.right > bounds.right) list.scrollLeft += tab.right - bounds.right
    }, [focused, allPanes, mobile])
    const focusPane = useCallback((id: string) => {
        store.focus(id)
        requestAnimationFrame(() => {
            const pane = root.current?.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
            const input = pane?.querySelector<HTMLElement>('textarea:not([disabled]), [contenteditable]:not([contenteditable="false"])')
            ;(input ?? pane)?.focus({ preventScroll: true })
        })
    }, [store])
    const changeWorkspace = useCallback((delta: number) => {
        const snapshot = store.get(), index = snapshot.workspaces.findIndex(w => w.id === snapshot.activeId)
        const next = snapshot.workspaces[Math.max(0, Math.min(snapshot.workspaces.length - 1, index + delta))]
        if (next) store.activate(next.id)
    }, [store])
    useEffect(() => {
        const navigation = bottom.current
        if (!navigation) return
        const wheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.metaKey) return
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
            if (event.target instanceof Element && event.target.closest('.workspace-pane-tabs')) {
                const list = paneTabs.current
                if (list && list.scrollWidth > list.clientWidth) {
                    event.preventDefault()
                    list.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1)
                }
                return
            }
            event.preventDefault()
            if (performance.now() - lastWheel.current < 250) return
            if (Math.sign(delta) !== Math.sign(wheelAmount.current)) wheelAmount.current = 0
            wheelAmount.current += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? navigation.clientWidth : 1)
            if (Math.abs(wheelAmount.current) < 45) return
            lastWheel.current = performance.now()
            changeWorkspace(Math.sign(wheelAmount.current))
            wheelAmount.current = 0
        }
        navigation.addEventListener('wheel', wheel, { passive: false })
        return () => navigation.removeEventListener('wheel', wheel)
    }, [changeWorkspace])
    const focusDirection = useCallback((key: string) => {
        const model = active ? models.current.get(active.id) : null
        if (!model || !focused) return
        const from = model.getNodeById(focused)?.getRect()
        if (!from) return
        const fx = from.x + from.width / 2, fy = from.y + from.height / 2
        const ranked = allPanes.filter(p => p.id !== focused).map(p => {
            const r = model.getNodeById(p.id)!.getRect(), dx = r.x + r.width / 2 - fx, dy = r.y + r.height / 2 - fy
            const direction = key === 'ArrowLeft' ? -dx : key === 'ArrowRight' ? dx : key === 'ArrowUp' ? -dy : dy
            return { id: p.id, direction, distance: Math.hypot(dx, dy) }
        }).filter(p => p.direction > 1).sort((a, b) => a.distance - b.distance)
        if (ranked[0]) focusPane(ranked[0].id)
    }, [active?.id, focused, allPanes, focusPane])
    const [prefix, setPrefix] = useState(false)
    const prefixRef = useRef(false)
    const prefixTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => {
        const clear = () => { prefixRef.current = false; setPrefix(false); clearTimeout(prefixTimer.current) }
        const handle = (event: KeyboardEvent) => {
            if (event.isComposing || event.repeat) return
            // Nonmodal feature tips may remain open beside the composer. They
            // must not disable workspace navigation when focus is elsewhere.
            const inDialog = event.target instanceof Element && event.target.closest('[role="dialog"]')
            const modalOpen = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
                .some(dialog => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
            if (inDialog || modalOpen) { clear(); return }
            const ctrlB = event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'b'
            if (!prefixRef.current) {
                if (!ctrlB) return
                event.preventDefault(); event.stopImmediatePropagation()
                prefixRef.current = true; setPrefix(true)
                prefixTimer.current = setTimeout(clear, 1500)
                return
            }
            clear()
            // Let the second Ctrl-b reach xterm exactly once.
            if (ctrlB) return
            event.preventDefault(); event.stopImmediatePropagation()
            if (event.key === '%') split('horizontal')
            else if (event.key === '"') split('vertical')
            else if (event.key === 'z') store.zoom()
            else if (event.key === 'x' && focused) store.closePane(focused)
            else if (event.key === 'c') createWindow()
            else if (event.key === 'w') setSwitcherOpen(true)
            else if (['h', 'j', 'k', 'l'].includes(event.key)) focusDirection(({ h: 'ArrowLeft', j: 'ArrowDown', k: 'ArrowUp', l: 'ArrowRight' } as Record<string, string>)[event.key])
            else if (event.key === 'n') changeWorkspace(1)
            else if (event.key === 'p') changeWorkspace(-1)
            else if (event.key === 'o') { const next = allPanes[(allPanes.findIndex(p => p.id === focused) + 1) % allPanes.length]; if (next) focusPane(next.id) }
            else if (event.key.startsWith('Arrow')) focusDirection(event.key)
            else if (/^[1-9]$/.test(event.key)) { const w = store.get().workspaces[Number(event.key) - 1]; if (w) store.activate(w.id) }
        }
        window.addEventListener('keydown', handle, true)
        return () => { clearTimeout(prefixTimer.current); window.removeEventListener('keydown', handle, true) }
    }, [store, focused, allPanes, changeWorkspace, focusDirection, focusPane, split, createWindow])
    const Pane = props.renderPane ?? WorkspacePane
    const [renameId, setRenameId] = useState<string | null>(null)
    const [rename, setRename] = useState('')
    return <div ref={root} className="workspace-shell" data-mobile={mobile} data-workspace-ready="true">
        <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <DialogContent className="workspace-dialog max-w-sm" aria-describedby={undefined}>
                <DialogHeader><DialogTitle>{t('workspace.switch')}</DialogTitle></DialogHeader>
                <div className="workspace-picker">{state.workspaces.map(w => <button type="button" key={w.id} aria-current={w.id === active?.id ? 'page' : undefined}
                    onClick={() => { store.activate(w.id); setSwitcherOpen(false) }}><span className="workspace-picker-name" title={w.name}>{w.name}</span><span className="workspace-picker-count">{t('workspace.paneCount', { count: panes(w.root).length })}</span></button>)}</div>
            </DialogContent>
        </Dialog>
        {closedNotice ? <div className="workspace-toast" role="status"><span>{t('workspace.closed')}</span><button type="button" onClick={() => { store.undoClose(); setClosedNotice(false) }}>{t('workspace.undo')}</button></div> : null}
        <div className="workspace-layout">
            {active && state.temporaryIds.includes(active.id) ? <div className="workspace-temporary" role="status">
                <span>{t('workspace.temporary')}</span>
                <button type="button" onClick={() => store.shareTemporary(active.id)}>{t('workspace.shareTemporary')}</button>
                <button type="button" onClick={() => store.dismissTemporary(active.id)}>{t('workspace.followShared')}</button>
            </div> : null}
            {retained.map(w => <div key={w.id} className="workspace-stage" data-workspace-id={w.id}
                data-workspace-visible={w.id === active?.id} aria-hidden={w.id !== active?.id} inert={w.id !== active?.id}>
                <WorkspaceForeground.Provider value={w.id === active?.id}><WorkspaceLayout workspace={w} mobile={mobile}
                    focused={state.focused[w.id]} zoomed={!!state.zoomed[w.id]} store={store}
                    sessions={props.sessions} title={props.title} onPick={props.onPick} onMoveNew={moveToNewWindow} Pane={Pane} models={models.current} /></WorkspaceForeground.Provider>
            </div>)}
            {!active ? <div className="workspace-empty"><p>{t(state.sync.initialized ? 'workspace.noWorkspaces' : 'workspace.loading')}</p><button type="button" onClick={createWindow}>{t('workspace.create')}</button></div> : null}
        </div>
        <nav ref={bottom} className="workspace-bottom" aria-label={t('workspace.navigation')}>
            <button type="button" className="workspace-mode" onClick={mobile ? props.onPick : props.onSingle} title={t(mobile ? 'share.backToSessions' : 'workspace.single')} aria-label={t(mobile ? 'share.backToSessions' : 'workspace.single')}>
                {mobile ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg> : <WorkspaceIcon />}
            </button>
            <div className="workspace-pane-navigation">
                <div ref={paneTabs} className={`workspace-pane-tabs${mobile ? ' workspace-mobile-panes' : ''}`}>
                    {allPanes.map((p, i) => {
                        const title = p.resource.kind === 'empty' ? t('workspace.newPane')
                            : p.resource.kind === 'document' ? documentName(p.resource.document)
                            : props.title(p.resource.sessionId)
                        return <button type="button" key={p.id} className="workspace-pane-tab"
                            aria-pressed={p.id === focused} aria-label={mobile ? `P${i + 1}` : `P${i + 1}: ${title}`} title={title}
                            onClick={() => mobile ? store.focus(p.id) : focusPane(p.id)}>
                            <span className="workspace-pane-index">{p.resource.kind === 'document' ? '▤ ' : p.resource.kind === 'terminal' ? '⌘ ' : ''}P{i + 1}</span>
                            {!mobile ? <span className="workspace-pane-title">{title}</span> : null}
                            {p.resource.kind === 'chat' ? <WorkspaceActivity session={sessionFor(p)} /> : null}
                        </button>
                    })}
                </div>
                <button type="button" className="workspace-new-pane" disabled={!active}
                    aria-label={t('workspace.newPane')} title={t('workspace.newPane')}
                    onClick={() => { if (focusedNode?.resource.kind === 'empty') props.onPick(); else split('horizontal') }}>
                    <span aria-hidden="true">P＋</span>
                </button>
            </div>
            <div className="workspace-tabs">
                {state.workspaces.map(w => renameId === w.id ? <form key={w.id} onSubmit={e => { e.preventDefault(); store.rename(w.id, rename); setRenameId(null) }}>
                    <input autoFocus aria-label={t('workspace.rename')} value={rename} onChange={e => setRename(e.target.value)} onBlur={() => { store.rename(w.id, rename); setRenameId(null) }} onKeyDown={e => { if (e.key === 'Escape') setRenameId(null) }} />
                </form> : <div className="workspace-tab" key={w.id}>
                    <button type="button" aria-current={w.id === active?.id ? 'page' : undefined} onClick={() => store.activate(w.id)} onDoubleClick={() => { setRename(w.name); setRenameId(w.id) }} title={w.name}>
                        <span>{w.name}</span>
                    </button>
                    <button type="button" className="workspace-tab-close" aria-label={`${t('workspace.close')}: ${w.name}`} onClick={() => closeWorkspace(w.id)}>×</button>
                </div>)}
            </div>
            {prefix ? <span className="workspace-prefix">Ctrl-b</span> : null}
            {state.sync.status === 'offline' || state.sync.status === 'error' ? <button type="button" className="workspace-sync-state" data-state={state.sync.status} title={state.sync.error ?? t('workspace.offline')} onClick={() => store.retrySync()}>{t(state.sync.status === 'offline' ? 'workspace.offline' : 'workspace.syncFailed')}</button> : null}
            {state.sync.status === 'syncing' && state.sync.pending > 0 ? <span className="workspace-sync-pending" title={t('workspace.syncing')}>↑{state.sync.pending}</span> : null}
            {mobile && focusedNode ? focusedNode.resource.kind === 'chat' ? <div className="workspace-header-dock" data-workspace-header={focusedNode.id} />
                : <PaneMenu id={focusedNode.id} store={store} onPick={props.onPick} onMoveNew={moveToNewWindow} /> : null}
            <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}><Popover.Trigger asChild><button type="button" aria-label={t('workspace.actions')}>···</button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="workspace-menu" side="top" align="end" sideOffset={8} collisionPadding={8}>
                    <button type="button" onClick={() => { setMenuOpen(false); createWindow() }}>{t('workspace.create')}</button>
                    {state.sync.status === 'error' && state.sync.pending > 0 ? <button type="button" onClick={() => { store.discardFailedOperation(); setMenuOpen(false) }}>{t('workspace.discardFailed')}</button> : null}
                    {state.sync.skipped ? <div className="workspace-key-help" role="status">{t('workspace.conflictNotice')}<button type="button" onClick={() => store.clearSyncNotice()}>{t('button.close')}</button></div> : null}
                    <button type="button" onClick={props.onSingle}>{t('workspace.single')}</button>
                    <button type="button" onClick={() => { setMenuOpen(false); setSwitcherOpen(true) }}>{t('workspace.switch')}</button>
                    <button type="button" onClick={() => { if (active) { setMenuOpen(false); setRename(active.name); setRenameId(active.id) } }}>{t('workspace.rename')}</button>
                    <button type="button" disabled={!active} onClick={() => { if (active) closeWorkspace(active.id) }}>{t('workspace.close')}</button>
                    <button type="button" disabled={!store.canUndo()} onClick={() => { store.undoClose(); setClosedNotice(false); setMenuOpen(false) }}>{t('workspace.undoClose')}</button>
                    <div className="workspace-key-help">Ctrl-b c · {t('workspace.create')}<br />Ctrl-b % / " · {t('workspace.split')}<br />Ctrl-b z · {t('workspace.zoom')}<br />Ctrl-b h j k l / ← ↓ ↑ → · {t('workspace.focus')}<br />Ctrl-b w · {t('workspace.switch')}</div>
                </Popover.Content></Popover.Portal>
            </Popover.Root>
        </nav>
    </div>
}


const WorkspaceLayout = memo(function WorkspaceLayout(props: {
    workspace: WorkspaceDocument; mobile: boolean; focused?: string; models: Map<string, Model>; zoomed: boolean
    store: WorkspaceStore; sessions?: SessionSummary[]; title: (id: string) => string
    onPick: () => void; onMoveNew: (id: string) => void; Pane: ComponentType<PaneProps>
}) {
    const { workspace: active, store, mobile, focused, Pane } = props
    const { t } = useTranslation()
    const allPanes = useMemo(() => panes(active.root), [active.root])
    const projected = mobile || props.zoomed
    const previous = useRef<{ model: Model; root: WorkspaceNode; titles: string } | null>(null)
    const titleKey = String(mobile) + allPanes.map(p => p.resource.kind === 'empty' ? '' : props.title(p.resource.sessionId)).join('\n')
    const model = useMemo(() => {
        const cached = previous.current
        if (cached?.root === active.root && cached.titles === titleKey) return cached.model
        const next = workspaceModel(active, props.title, cached?.model, mobile)
        next.setOnAllowDrop((_node, info) => info.location !== DockLocation.CENTER)
        return next
    }, [active.root, titleKey])
    useLayoutEffect(() => { props.models.set(active.id, model); return () => { props.models.delete(active.id) } }, [props.models, active.id, model])
    useLayoutEffect(() => { previous.current = { model, root: active.root, titles: titleKey } }, [model, active.root, titleKey])
    useLayoutEffect(() => {
        if (!focused) return
        const target = model.getNodeById(focused)?.getParent()
        if (!target) return
        const maximized = model.getMaximizedTabset()
        if (maximized && (!projected || maximized.getId() !== target.getId())) model.doAction(Actions.maximizeToggle(maximized.getId()))
        if (projected && model.getMaximizedTabset()?.getId() !== target.getId()) model.doAction(Actions.maximizeToggle(target.getId()))
        if (model.getActiveTabset()?.getId() !== target.getId()) model.doAction(Actions.setActiveTabset(target.getId()))
    }, [model, projected, focused])
    const sessionFor = (pane?: PaneNode) => { const resource = pane?.resource; return resource?.kind === 'chat' ? props.sessions?.find(s => s.id === resource.sessionId) : undefined }
    const changed = (next: Model, action: { type: string }) => {
        if (store.get().activeId !== active.id) return
        // Programmatic selection/zoom changes are local; never serialize them.
        if ([Actions.SET_ACTIVE_TABSET, Actions.SELECT_TAB, Actions.MAXIMIZE_TOGGLE].includes(action.type)) {
            const selected = next.getActiveTabset()?.getSelectedNode()
            if (selected && selected.getId() !== store.focusedPane()?.id) store.focus(selected.getId())
            return
        }
        const w = active
        const tree = workspaceTree(next, w)
        if (tree) {
            previous.current = { model: next, root: tree, titles: titleKey }
            store.setRoot(w.id, tree)
        }
    }
    return (
        <Layout model={model} realtimeResize supportsPopout={false}
                onAction={action => { store.capture(); return action }} onModelChange={changed}
                onExternalDrag={() => {
                    const id = store.draggingSessionId
                    if (!id) return undefined
                    const existing = store.get().workspaces.flatMap(w => panes(w.root)).find(p => p.resource.kind === 'chat' && p.resource.sessionId === id)
                    if (existing) return undefined
                    const pane: PaneNode = { type: 'pane', id: crypto.randomUUID(), resource: { kind: 'chat', sessionId: id } }
                    return { json: { type: 'tab', id: pane.id, name: props.title(id), component: 'chat', config: pane }, onDrop: node => { store.draggingSessionId = null; if (node) store.focus(node.getId()) } }
                }}
                factory={node => {
                    const pane = allPanes.find(p => p.id === node.getId())
                    return pane ? <VisiblePane node={node} pane={pane} focused={pane.id === focused} projected={projected} store={store} pickSession={props.onPick} Component={Pane} /> : null
                }}
                onRenderTab={(node, values) => {
                    const session = sessionFor(allPanes.find(p => p.id === node.getId()))
                    values.content = <span className="workspace-header-title">{session ? <MachineIdentityIcon machineId={session.metadata?.machineId} className="workspace-machine-icon" /> : null}<span>{node.getComponent() === 'empty' ? t('workspace.newPane') : node.getName()}</span></span>
                }}
                onRenderTabSet={(group, values) => {
                    if (!(group instanceof TabSetNode)) return
                    const id = group.getChildren()[0]?.getId()
                    if (!id) return
                    if (mobile) return
                    values.buttons.push(<span key="number" className="workspace-header-number">{allPanes.findIndex(p => p.id === id) + 1}</span>)
                    values.buttons.push(<button type="button" key="zoom" className="workspace-header-zoom" aria-label={t('workspace.zoom')} title={t('workspace.zoom')} onPointerDown={e => e.stopPropagation()} onClick={() => { store.focus(id); store.zoom() }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3H3v5m0-5 6 6M16 3h5v5m0-5-6 6M3 16v5h5m-5 0 6-6m12 1v5h-5m5 0-6-6" /></svg></button>)
                    if (allPanes.find(p => p.id === id)?.resource.kind === 'chat') values.buttons.push(<div key="chat-actions" className="workspace-header-dock" data-workspace-header={id} />)
                    else values.buttons.push(<PaneMenu key="pane-menu" id={id} store={store} onPick={props.onPick} onMoveNew={props.onMoveNew} />)
                }} />
    )
})

function VisiblePane(props: PaneProps & { node: TabNode; projected: boolean; Component: ComponentType<PaneProps> }) {
    const foreground = useContext(WorkspaceForeground)
    const root = useRef<HTMLDivElement>(null)
    // Zoom/phone switches are known before FlexLayout changes DOM geometry.
    const visible = !props.projected || props.focused
    const [opened, setOpened] = useState(visible)
    if (visible && !opened) setOpened(true)
    useLayoutEffect(() => {
        if (!visible || !foreground) return
        // Capture before focus/zoom changes let FlexLayout hide or zero this
        // panel. Its virtual readers must keep their own last visible size.
        const saveSize = () => {
            const panel = root.current?.closest<HTMLElement>('.flexlayout__tab')
            if (!panel || getComputedStyle(panel).visibility === 'hidden') return
            const { width, height } = panel.getBoundingClientRect()
            if (width > 0 && height > 0) {
                panel.style.setProperty('--workspace-pane-width', `${width}px`)
                panel.style.setProperty('--workspace-pane-height', `${height}px`)
            }
        }
        const callbacks = props.store.callbacks(props.pane.id)
        callbacks.add(saveSize)
        saveSize()
        return () => { callbacks.delete(saveSize) }
    }, [visible, foreground, props.store, props.pane.id])
    useLayoutEffect(() => {
        if (!visible) return
        return () => { for (const save of props.store.callbacks(props.pane.id)) save() }
    }, [visible, props.store, props.pane.id])
    return <div ref={root} className="workspace-pane-presence" data-pane-visible={visible} data-pane-retained={opened} aria-hidden={!visible || !foreground} inert={!visible || !foreground}>
        {opened ? <props.Component pane={props.pane} focused={visible && props.focused && foreground} foreground={visible && foreground} store={props.store} pickSession={props.pickSession} /> : null}
    </div>
}

function PaneMenu(props: { id: string; store: WorkspaceStore; onPick: () => void; onMoveNew: (id: string) => void }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    return <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild><button type="button" className="workspace-pane-menu" aria-label={t('workspace.paneActions')} title={t('workspace.paneActions')} onPointerDown={e => e.stopPropagation()}>···</button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="workspace-menu" align="end" sideOffset={5} collisionPadding={8} onKeyDown={e => e.stopPropagation()}>
            <WorkspacePaneActions {...props} onClose={() => setOpen(false)} />
        </Popover.Content></Popover.Portal>
    </Popover.Root>
}
