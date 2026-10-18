import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import { documentName, DocumentRefSchema, type DocumentRef } from '@hapi/protocol/documents'
import { SessionFiles } from '@/routes/sessions/files'
import type { FileManagerMutation } from '@/components/SessionFiles/file-manager-types'
import { DocumentSurface } from '@/documents/DocumentSurface'
import { DocumentLeavePrompt } from '@/documents/DocumentLeaveDialog'
import type { DocumentSession } from '@/documents/documentSession'
import { useDocumentRegistry } from '@/documents/useDocumentRegistry'
import { useAppContext } from '@/lib/app-context'
import { useSession } from '@/hooks/queries/useSession'
import { usePaneNavigate } from '@/workspace/PaneContext'
import { workspaceStorageKey } from '@/workspace/workspaceStore'
import { resolveAbsoluteFilePath } from '@/lib/file-path'
import { decodeBase64 } from '@/lib/utils'
import { fileManagerTargetFromPath, parseSessionFilesSearch, type SessionFilesSearch } from '@/lib/session-files-navigation'
import { FileWorkbenchStore, fileWorkbenches, registerFileWorkbench } from './fileWorkbenchStore'
import { FileWorkbenchNavigationContext } from './context'
import { useFileWorkbenchLabels } from './labels'
import './file-workbench.css'

type FileRequest = { path?: string; document?: string }
export function requestedDocument(request: FileRequest | undefined, root?: string, machineId?: string): DocumentRef | undefined {
    if (request?.document) {
        try {
            const decoded = decodeBase64(request.document)
            const result = decoded.ok ? DocumentRefSchema.safeParse(JSON.parse(decoded.text)) : undefined
            if (result?.success) return result.data
        } catch { return undefined }
    }
    if (!request?.path) return undefined
    const decoded = decodeBase64(request.path)
    return { kind: 'file', path: resolveAbsoluteFilePath(root, decoded.ok ? decoded.text : request.path), ...(machineId ? { machineId } : {}) }
}

export function SessionFileWorkbench(props: {
    sessionId: string
    search?: SessionFilesSearch
    revealKey?: string | number
    requested?: FileRequest
    foreground?: boolean
    onBack: () => void
    onDocumentChange?: (document: DocumentRef | undefined) => void
}) {
    const { api, baseUrl, token, workspace } = useAppContext()
    const instanceId = useId()
    const { session } = useSession(api, props.sessionId)
    const labels = useFileWorkbenchLabels()
    const parentNavigate = usePaneNavigate()
    const registry = useDocumentRegistry()
    const scope = workspaceStorageKey(baseUrl, token)
    const store = useMemo(() => new FileWorkbenchStore(scope, props.sessionId), [scope, props.sessionId])
    const state = useSyncExternalStore(store.subscribe, store.get)
    const [search, setSearch] = useState<SessionFilesSearch>({ ...props.search, tab: 'directories' })
    const [reveal, setReveal] = useState(0)
    const [mobileTree, setMobileTree] = useState(!props.requested)
    const [desktopTree, setDesktopTree] = useState(true)
    const [wide, setWide] = useState(false)
    const [error, setError] = useState<string>()
    const [leave, setLeave] = useState<{ sessions: DocumentSession[]; sessionId: string; finish: (ok: boolean) => void }>()
    const locked = useRef(new Map<FileManagerMutation, DocumentSession[]>())
    const mounted = useRef(true)
    const resizeCleanup = useRef<(() => void) | undefined>(undefined)
    const pendingLeave = useRef(leave)
    pendingLeave.current = leave
    const root = useRef<HTMLDivElement>(null)
    const visited = useRef<string[]>([])
    const requested = useMemo(() => requestedDocument(props.requested, session?.metadata?.path, session?.metadata?.machineId),
        [props.requested?.path, props.requested?.document, session?.metadata?.path, session?.metadata?.machineId])
    const active = state.tabs.find(tab => tab.id === state.activeId)
    const activePath = active?.resource.document.kind === 'file' ? active.resource.document.path : undefined
    const activeTarget = activePath ? fileManagerTargetFromPath(activePath, session?.metadata?.path) : undefined
    const foreground = props.foreground !== false
    const currentView = useRef({ store, foreground })
    currentView.current = { store, foreground }
    const onDocumentChange = useRef(props.onDocumentChange)
    onDocumentChange.current = props.onDocumentChange
    useEffect(() => registerFileWorkbench(registry, store), [registry, store])
    useEffect(() => {
        if (requested && session?.metadata?.path) { store.open(requested); setMobileTree(false) }
    }, [store, requested, session?.metadata?.path])
    useEffect(() => {
        setSearch({ ...props.search, tab: 'directories' })
        if (props.search?.target) { setReveal(value => value + 1); setMobileTree(true) }
    }, [props.search?.query, props.search?.target, props.revealKey])
    useLayoutEffect(() => {
        const node = root.current
        if (!node) return
        const measure = () => setWide(node.clientWidth >= 700)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            resizeCleanup.current?.()
            pendingLeave.current?.finish(false)
            // A submitted disk mutation still owns its document guards.
            // Its settled callback releases them after reconciliation.
        }
    }, [])
    if (active) visited.current = [...visited.current.filter(id => id !== active.id && state.tabs.some(tab => tab.id === id)), active.id]
    const retained = new Set(visited.current.filter(id => state.tabs.some(tab => tab.id === id)).slice(-5))
    const open = useCallback((ref: DocumentRef) => {
        if (store.open(ref)) {
            setMobileTree(false)
            onDocumentChange.current?.(ref)
        }
    }, [store])
    const openFile = (path: string) => open({ kind: 'file', path: resolveAbsoluteFilePath(session?.metadata?.path, path), machineId: session?.metadata?.machineId })
    const select = (id: string) => {
        store.select(id); setMobileTree(false)
        const tab = store.get().tabs.find(item => item.id === id)
        if (tab) onDocumentChange.current?.(tab.resource.document)
    }
    const confirmLeave = (sessions: DocumentSession[]) => new Promise<boolean>(resolve => {
        setLeave({ sessions, sessionId: props.sessionId, finish: ok => { setLeave(undefined); resolve(ok) } })
    })
    const close = async (ids: string[]) => {
        const targets = store.get().tabs.filter(tab => ids.includes(tab.id))
        const documents = targets.map(tab => registry.get(tab.resource))
        if (documents.some(document => document.state.fileOperation || document.state.saving)) { setError(labels.busy); return }
        const dirty = documents.filter(document => registry.isDirty(document.resource))
        if (dirty.length && !await confirmLeave(dirty)) return
        store.close(ids)
        const next = store.get().tabs.find(tab => tab.id === store.get().activeId)
        if (next) onDocumentChange.current?.(next.resource.document)
        else { setMobileTree(true); onDocumentChange.current?.(undefined) }
    }
    const navigate = useCallback<ReturnType<typeof useNavigate>>(async options => {
        const target = options.params as { sessionId?: string } | undefined
        if (target?.sessionId && target.sessionId !== props.sessionId) { await parentNavigate(options); return }
        if (options.to === '/sessions/$sessionId/files') {
            const next = parseSessionFilesSearch((options.search ?? {}) as Record<string, unknown>)
            if (next.tab === 'changes') { await parentNavigate(options); return }
            setSearch({ ...next, tab: 'directories' }); setReveal(value => value + 1); setMobileTree(true)
        } else if (options.to === '/sessions/$sessionId/file') {
            const request = options.search as FileRequest & { staged?: boolean }
            if (request?.staged !== undefined) { await parentNavigate(options); return }
            const ref = requestedDocument(request, session?.metadata?.path, session?.metadata?.machineId)
            if (ref) open(ref)
        } else await parentNavigate(options)
    }, [open, parentNavigate, props.sessionId, session?.metadata?.path, session?.metadata?.machineId])
    const revealPath = useCallback((path: string) => {
        const target = fileManagerTargetFromPath(path, session?.metadata?.path)
        if (!target) return
        setSearch({ tab: 'directories', target }); setReveal(value => value + 1); setMobileTree(true); setDesktopTree(true)
    }, [session?.metadata?.path])
    const navigation = useMemo(() => ({ sessionId: props.sessionId, open, navigate, reveal: revealPath }), [props.sessionId, open, navigate, revealPath])
    const absolutePaths = (mutation: FileManagerMutation) => mutation.paths.map(path => resolveAbsoluteFilePath(session?.metadata?.path, path))
    const owner = { sessionId: props.sessionId, machineId: session?.metadata?.machineId }
    const beforeMutation = async (mutation: FileManagerMutation) => {
        if (!['rename', 'move', 'delete'].includes(mutation.operation)) return true
        const affected = registry.fileSessions(owner, absolutePaths(mutation))
        for (const document of affected) {
            if (document.state.saving || document.state.fileOperation) throw new Error(labels.busy)
            if (registry.isDirty(document.resource)) await document.restoreLocalDraft()
        }
        if (mutation.destination) {
            const destination = resolveAbsoluteFilePath(session?.metadata?.path, mutation.destination)
            const collision = registry.fileSessions(owner, [destination]).filter(document => !affected.includes(document))
            if (collision.some(document => registry.isDirty(document.resource) || document.state.saving)) throw new Error('The destination has an unsaved document.')
        }
        if (mutation.operation === 'delete') {
            const dirty = affected.filter(document => registry.isDirty(document.resource))
            if (dirty.length && !await confirmLeave(dirty)) return false
        }
        const acquired: DocumentSession[] = []
        try {
            for (const document of affected) {
                document.beginFileOperation(); acquired.push(document)
                if (document.state.dirty) await document.persist()
            }
            locked.current.set(mutation, acquired)
            return true
        } catch (reason) { acquired.forEach(document => document.endFileOperation()); throw reason }
    }
    const afterMutation = async (mutation: FileManagerMutation) => {
        const paths = absolutePaths(mutation)
        const mayNavigate = () => mounted.current && currentView.current.store === store && currentView.current.foreground
        if (mutation.operation === 'rename' || mutation.operation === 'move') {
            if (!mutation.destination || paths.length !== 1) return
            const destination = resolveAbsoluteFilePath(session?.metadata?.path, mutation.destination)
            let failure: unknown
            try { await registry.relocateFiles(owner, paths[0], destination) } catch (reason) { failure = reason }
            for (const reader of fileWorkbenches(registry, store)) reader.relocate(paths[0], destination, owner)
            workspace?.relocateDocuments(owner, paths[0], destination)
            const current = store.get().tabs.find(tab => tab.id === store.get().activeId)
            if (current && mayNavigate()) onDocumentChange.current?.(current.resource.document)
            if (failure) throw failure
        } else if (mutation.operation === 'delete') {
            registry.invalidateFiles(owner, paths)
            for (const reader of fileWorkbenches(registry, store)) reader.close(reader.affected(paths, owner).map(tab => tab.id))
            workspace?.removeDeletedDocuments(owner, paths)
            const current = store.get().tabs.find(tab => tab.id === store.get().activeId)
            if (mayNavigate()) {
                onDocumentChange.current?.(current?.resource.document)
                if (!current) setMobileTree(true)
            }
        } else {
            const changed = mutation.operation === 'copy' && mutation.destination
                ? [resolveAbsoluteFilePath(session?.metadata?.path, mutation.destination)] : paths
            registry.invalidateFiles(owner, changed)
        }
    }
    const settleMutation = (mutation: FileManagerMutation) => {
        locked.current.get(mutation)?.forEach(document => document.endFileOperation())
        locked.current.delete(mutation)
    }
    const revealActive = () => {
        if (!activePath) return
        revealPath(activePath)
    }
    const resize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!wide) return
        resizeCleanup.current?.()
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        const start = event.clientX, width = state.treeWidth
        const node = event.currentTarget
        const move = (next: PointerEvent) => store.resize(width + next.clientX - start)
        const finish = () => {
            node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', finish); node.removeEventListener('pointercancel', finish)
            if (resizeCleanup.current === finish) resizeCleanup.current = undefined
        }
        resizeCleanup.current = finish
        node.addEventListener('pointermove', move); node.addEventListener('pointerup', finish); node.addEventListener('pointercancel', finish)
    }
    const switchTab = (direction: number) => {
        const index = state.tabs.findIndex(tab => tab.id === state.activeId)
        const tab = state.tabs[(index + direction + state.tabs.length) % state.tabs.length]
        if (tab) { select(tab.id); document.getElementById(`${instanceId}-file-tab-${tab.id}`)?.focus() }
    }
    return <FileWorkbenchNavigationContext.Provider value={navigation}>
        <div ref={root} className="file-workbench" data-wide={wide} data-tree={mobileTree || !active} data-desktop-tree={desktopTree}
            style={{ '--file-tree-width': `${state.treeWidth}px` } as CSSProperties}
            onKeyDown={event => {
                if (!(event.ctrlKey || event.metaKey)) return
                if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); switchTab(event.key === 'PageDown' ? 1 : -1) }
                if (event.key.toLowerCase() === 'w' && active) { event.preventDefault(); void close([active.id]) }
            }}>
            <div className="file-workbench-toolbar">
                <button type="button" onClick={() => {
                    if (wide ? desktopTree : mobileTree) { if (wide) setDesktopTree(false); else setMobileTree(false) }
                    else revealActive()
                }} aria-pressed={wide ? desktopTree : mobileTree} disabled={!active}>{(wide ? desktopTree : mobileTree) ? labels.showFile : labels.showTree}</button>
                <button type="button" onClick={revealActive} disabled={!activeTarget}>{labels.reveal}</button>
                {active && state.tabs.length > 1 ? <button type="button" onClick={() => void close(state.tabs.filter(tab => tab.id !== active.id).map(tab => tab.id))}>{labels.closeOthers}</button> : null}
            </div>
            {error || state.error ? <p className="file-workbench-notice" role="alert">{error || state.error}</p> : null}
            <div className="file-workbench-body">
                <div className="file-workbench-tree" inert={!wide && !mobileTree && !!active} aria-hidden={!wide && !mobileTree && !!active || undefined}>
                    <SessionFiles sessionId={props.sessionId} search={search} revealKey={reveal} onBack={props.onBack}
                        activeFilePath={activeTarget} onOpenFile={openFile} foreground={foreground && ((wide && desktopTree) || (!wide && mobileTree) || !active)}
                        beforeFileMutation={beforeMutation} onFileMutation={afterMutation} onFileMutationSettled={settleMutation} />
                </div>
                {active ? <>
                    <div className="file-workbench-resizer" role="separator" tabIndex={wide ? 0 : -1} aria-orientation="vertical"
                        aria-label={labels.resize} aria-valuemin={180} aria-valuemax={480} aria-valuenow={state.treeWidth}
                        onPointerDown={resize} onKeyDown={event => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); store.resize(state.treeWidth + (event.key === 'ArrowRight' ? 20 : -20)) }
                        }} />
                    <div className="file-workbench-documents" inert={!wide && mobileTree} aria-hidden={!wide && mobileTree || undefined}>
                        <div className="file-workbench-tabs" role="tablist" aria-label={labels.tabs}>
                            {state.tabs.map(tab => {
                                const name = documentName(tab.resource.document), path = tab.resource.document.kind === 'file' ? tab.resource.document.path : name
                                return <div className="file-workbench-tab" key={tab.id} data-path={path} data-active={tab.id === state.activeId}
                                    draggable onDragStart={event => event.dataTransfer.setData('application/x-hapi-file-tab', tab.id)}
                                    onDragOver={event => { if (event.dataTransfer.types.includes('application/x-hapi-file-tab')) event.preventDefault() }}
                                    onDrop={event => { const id = event.dataTransfer.getData('application/x-hapi-file-tab'); if (id) { event.preventDefault(); store.reorder(id, tab.id) } }}>
                                    <button type="button" role="tab" id={`${instanceId}-file-tab-${tab.id}`} aria-controls={`${instanceId}-file-panel-${tab.id}`} aria-selected={tab.id === state.activeId}
                                        tabIndex={tab.id === state.activeId ? 0 : -1} title={path} onClick={() => select(tab.id)}
                                        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); switchTab(event.key === 'ArrowRight' ? 1 : -1) } }}>{name}</button>
                                    <button type="button" aria-label={`${labels.close} ${name}`} title={path} onClick={() => void close([tab.id])}>×</button>
                                </div>
                            })}
                        </div>
                        <div className="file-workbench-readers">
                            {state.tabs.filter(tab => retained.has(tab.id)).map(tab => <div key={tab.id} id={`${instanceId}-file-panel-${tab.id}`} role="tabpanel" aria-labelledby={`${instanceId}-file-tab-${tab.id}`}
                                className="file-workbench-reader" hidden={tab.id !== state.activeId} inert={tab.id !== state.activeId}>
                                <DocumentSurface resource={tab.resource} foreground={foreground && tab.id === state.activeId && (wide || !mobileTree)} />
                            </div>)}
                        </div>
                    </div>
                </> : <div className="file-workbench-empty">{labels.empty}</div>}
            </div>
            <DocumentLeavePrompt request={leave} />
        </div>
    </FileWorkbenchNavigationContext.Provider>
}
