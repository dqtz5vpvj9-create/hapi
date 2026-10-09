import { DocumentSurface } from '@/documents/DocumentSurface'
import { DocumentRefSchema, type DocumentRef } from '@hapi/protocol/documents'
import { decodeBase64 } from '@/lib/utils'
import { resolveAbsoluteFilePath } from '@/lib/file-path'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { SessionPaneController } from '@/components/SessionPaneController'
import { SessionWorkspace } from '@/components/SessionWorkspace'
import { SessionFiles } from '@/routes/sessions/files'
import { SessionFile } from '@/routes/sessions/file'
import { SessionTerminal } from '@/routes/sessions/terminal'
import { useAppContext } from '@/lib/app-context'
import { useSession } from '@/hooks/queries/useSession'
import { useSelectedSessionSeen } from '@/hooks/useSelectedSessionSeen'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import { getSupersedingSessionId, prepareFollowSupersedingSession, shouldFollowSupersedingSession } from '@/routes/sessions/followSupersedingSession'
import { WorkspacePaneActions } from './WorkspacePaneActions'
import { PaneContext } from './PaneContext'
import { panes as flatten, type PaneNode, type WorkspaceStore } from './workspaceStore'
import { useTranslation } from '@/lib/use-translation'
import { syncTailMessages } from '@/lib/message-window-store'

export function WorkspacePane(props: { pane: PaneNode; focused: boolean; foreground?: boolean; store: WorkspaceStore; pickSession: () => void }) {
    const root = useRef<HTMLDivElement>(null)
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { pane, store } = props
    const sessionId = pane.resource.kind === 'empty' ? '' : pane.resource.sessionId
    const wasForeground = useRef(props.foreground !== false)
    useEffect(() => {
        const foreground = props.foreground !== false
        if (foreground && !wasForeground.current && api && pane.resource.kind === 'chat') {
            // Returning shows the retained DOM immediately; freshness is separate.
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
        wasForeground.current = foreground
    }, [api, props.foreground, sessionId, pane.resource.kind])
    const { session } = useSession(api, sessionId || null)
    useSelectedSessionSeen(props.focused && pane.resource.kind === 'chat' ? sessionId : null, session?.updatedAt)
    const routeNavigate = useNavigate()
    const [tool, setTool] = useState<{ view: 'directories' | 'changes' | 'file'; path?: string; staged?: boolean; query?: string } | null>(null)
    const closeTool = useCallback(() => setTool(null), [])
    useEffect(() => { setTool(null) }, [sessionId])
    const navigate = useCallback<ReturnType<typeof useNavigate>>(async options => {
        // Results from a replaced/closed resource must not take over its successor.
        const current = store.get().workspaces.flatMap(w => flatten(w.root)).find(p => p.id === pane.id)
        if (!current || current.resource.kind === 'empty' || current.resource.sessionId !== sessionId) return
        const target = options.params as { sessionId?: string } | undefined
        if (options.to === '/sessions/$sessionId/terminal') { store.focus(pane.id); store.terminal(sessionId); return }
        if (options.to === '/sessions/$sessionId/files') {
            const search = options.search as { tab?: 'directories' | 'changes'; query?: string } | undefined
            setTool({ view: search?.tab ?? 'changes', query: search?.query }); return
        }
        if (options.to === '/sessions/$sessionId/file') {
            const search = options.search as { path?: string; staged?: boolean; document?: string } | undefined
            if (search?.staged !== undefined) { setTool({ view: 'file', ...search }); return }
            let ref: DocumentRef
            if (search?.document) {
                const decoded = decodeBase64(search.document)
                if (!decoded.ok) return
                const parsed = DocumentRefSchema.safeParse(JSON.parse(decoded.text))
                if (!parsed.success) return
                ref = parsed.data
            } else {
                const decoded = decodeBase64(search?.path ?? '')
                const path = decoded.ok ? decoded.text : search?.path ?? ''
                ref = { kind: 'file', path: resolveAbsoluteFilePath(session?.metadata?.path, path), machineId: session?.metadata?.machineId }
            }
            store.openDocument(pane.id, pane.resource, { kind: 'document', sessionId, document: ref })
            setTool(null); return
        }
        if (options.to === '/sessions/$sessionId' && target?.sessionId) {
            if (target.sessionId !== sessionId) store.bind(pane.id, { kind: 'chat', sessionId: target.sessionId }, sessionId)
            setTool(null)
            if (store.focusedPane()?.id === pane.id) await routeNavigate(options)
            return
        }
        await routeNavigate(options)
    }, [store, pane, sessionId, session?.metadata?.path, session?.metadata?.machineId, routeNavigate])
    const menuItems = useCallback((close: () => void) => <WorkspacePaneActions id={pane.id} store={store} onPick={props.pickSession} onClose={close} onMoveNew={() => {
        store.create(t('workspace.defaultName', { number: store.get().workspaces.length + 1 }))
        store.movePane(pane.id, store.active()!.id)
    }} />, [pane.id, store, props.pickSession, t])
    const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null)
    useLayoutEffect(() => {
        const target = document.querySelector<HTMLElement>(`[data-workspace-header="${pane.id}"]`)
        if (target !== headerTarget) setHeaderTarget(target)
    })
    const context = useMemo(() => ({ paneId: pane.id, sessionId, focused: props.focused, root, navigate, headerTarget, menuItems, beforeHide: store.callbacks(pane.id), editing: store.editingCallbacks(pane.id) }), [pane.id, sessionId, props.focused, navigate, store, headerTarget, menuItems])
    const observed = useRef<{ sessionId: string; supersedingSessionId: string | null } | null>(null)
    useEffect(() => {
        if (!session || pane.resource.kind !== 'chat') return
        const superseding = getSupersedingSessionId(sessionId, session.metadata)
        const follow = shouldFollowSupersedingSession(observed.current, sessionId, session.metadata)
        observed.current = { sessionId, supersedingSessionId: superseding }
        if (follow && superseding) {
            void prepareFollowSupersedingSession(sessionId, superseding).then(() => {
                store.bind(pane.id, { kind: 'chat', sessionId: superseding }, sessionId)
            })
        }
    }, [session, sessionId, store, pane.id, pane.resource.kind])
    return <PaneContext.Provider value={context}>
        <div ref={root} className="workspace-pane" tabIndex={-1} data-session-id={sessionId} data-pane-id={pane.id} data-focused={props.focused}
            onPointerDownCapture={() => { if (!props.focused) store.focus(pane.id) }}
            onFocusCapture={() => { if (!props.focused) store.focus(pane.id) }}>
            {pane.resource.kind === 'empty' ? <div className="workspace-empty">
                <p>{t('workspace.empty')}</p><button type="button" onClick={props.pickSession}>{t('workspace.choose')}</button>
            </div> : pane.resource.kind === 'terminal' ? <SessionTerminal sessionId={sessionId} terminalId={pane.resource.terminalId} onBack={() => store.closePane(pane.id)} />
                : pane.resource.kind === 'document' ? <DocumentSurface key={JSON.stringify(pane.resource)} resource={pane.resource} foreground={props.foreground} />
                : <SessionWorkspace open={!!tool} view={tool?.view ?? 'changes'} path={session?.metadata?.path}
                    terminalAvailable={!!session?.active && isRemoteTerminalSupported(session.metadata)} filesAvailable={!!session?.metadata?.path}
                    onSelect={view => { if (view === 'terminal') { store.focus(pane.id); store.terminal(sessionId) } else setTool({ view }) }} onClose={closeTool}
                    chat={<SessionPaneController sessionId={sessionId} onBack={() => store.closePane(pane.id)} />}
                    panel={tool?.view === 'file' ? <SessionFile sessionId={sessionId} search={tool} onBack={() => setTool({ view: 'directories' })} />
                        : <SessionFiles sessionId={sessionId} search={{ tab: tool?.view, query: tool?.query }} onBack={closeTool} />} />}
        </div>
    </PaneContext.Provider>
}
