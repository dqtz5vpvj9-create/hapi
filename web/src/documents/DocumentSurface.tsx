import { createElement, lazy, Suspense, useEffect, useMemo, useRef, useState, useLayoutEffect, useSyncExternalStore, type HTMLAttributes } from 'react'
import type { ExtraProps } from 'react-markdown'
import { documentKey, documentName, MAX_EDITABLE_FILE_BYTES, type DocumentResource, type DocumentSelection } from '@hapi/protocol/documents'
import { artifactMimeFromFilename } from '@hapi/protocol/artifacts'
import { useAppContext } from '@/lib/app-context'
import { workspaceStorageKey, panes } from '@/workspace/workspaceStore'
import { usePaneEditing, usePane } from '@/workspace/PaneContext'
import { encodeBase64 } from '@/lib/utils'
import type { HtmlLink } from './htmlPreview'
import { useSession } from '@/hooks/queries/useSession'
import { usePaneNavigate } from '@/workspace/PaneContext'
import { getSessionTitle } from '@/lib/sessionTitle'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { DocumentRegistry, base64Bytes, decodeDocumentText, encodeDocumentText, type TextFormat } from './documentSession'
import { DocumentLeavePrompt } from './DocumentLeaveDialog'
import { DocumentEditor } from './DocumentEditor'
import { attachSelection } from './selectionDrafts'
import { useDocumentLabels } from './labels'
import './documents.css'

const PdfDocument = lazy(() => import('./PdfDocument'))
const SheetDocument = lazy(() => import('./SheetDocument'))
const ImageDocument = lazy(() => import('./ImageDocument'))
const HtmlDocument = lazy(() => import('./HtmlDocument'))
const localRegistries = new WeakMap<object, DocumentRegistry>()
const markdownBlocks = Object.fromEntries(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'pre'].map(tag => [tag,
    ({ node, ...props }: HTMLAttributes<HTMLElement> & ExtraProps) => createElement(tag, { ...props,
        'data-source-from': node?.position?.start.offset, 'data-source-to': node?.position?.end.offset }),
]))

export function DocumentSurface({ resource, foreground = true, onBack }: { resource: DocumentResource; foreground?: boolean; onBack?: () => void }) {
    const { api, workspace, baseUrl, token } = useAppContext()
    const labels = useDocumentLabels()
    const navigate = usePaneNavigate()
    const pane = usePane()
    const registry = useMemo(() => {
        if (workspace) return workspace.documents
        let value = localRegistries.get(api)
        if (!value) { value = new DocumentRegistry(workspaceStorageKey(baseUrl, token)); localRegistries.set(api, value) }
        return value
    }, [workspace, api, baseUrl, token])
    const session = useMemo(() => registry.get(resource), [registry, documentKey(resource)])
    const state = useSyncExternalStore(session.subscribe, session.get)
    usePaneEditing(state.dirty || state.saving)
    const { session: target } = useSession(api, state.targetSessionId)
    const preview = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        if (preview.current) preview.current.scrollTop = session.previewScrollTop
        return () => { if (preview.current) session.previewScrollTop = preview.current.scrollTop }
    }, [session, state.mode, state.phase])
    const [find, setFind] = useState(0)
    const [attached, setAttached] = useState(false)
    const [referenceError, setReferenceError] = useState<string>()
    const [disk, setDisk] = useState<{ text: string; hash: string; format: TextFormat }>()
    const [leaving, setLeaving] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [editorRevision, setEditorRevision] = useState(0)
    const name = documentName(resource.document)
    const extension = name.split('.').at(-1)?.toLowerCase()
    const office = /^(pptx?|docx?|od[tp])$/.test(extension ?? '')
    const sheet = /^(xlsx?|xlsm|ods)$/.test(extension ?? '')
    const markdown = /^(md|markdown|mdx)$/.test(extension ?? '')
    const html = /^(html|htm)$/.test(extension ?? '')
    const mime = artifactMimeFromFilename(name)
    useEffect(() => {
        session.users++
        return () => { session.users--; registry.trim() }
    }, [session, registry])
    useEffect(() => { if (foreground) void session.load(api) }, [session, api, foreground])
    useEffect(() => {
        if (!foreground || state.phase !== 'ready') return
        const check = () => { if (document.visibilityState !== 'hidden') void session.checkUpdates(api) }
        check()
        const interval = setInterval(check, 20000)
        window.addEventListener('online', check); document.addEventListener('visibilitychange', check)
        return () => { clearInterval(interval); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', check) }
    }, [session, api, foreground, state.phase])
    useEffect(() => {
        const unload = (event: BeforeUnloadEvent) => { if (session.state.dirty || session.state.saving) { event.preventDefault(); event.returnValue = '' } }
        window.addEventListener('beforeunload', unload)
        return () => window.removeEventListener('beforeunload', unload)
    }, [session])
    const select = (selection: DocumentSelection | undefined) => {
        if (!selection && !session.state.selection) return
        setAttached(false); session.patch({ selection })
    }
    const openHtmlLink = (link: HtmlLink) => {
        if (link.kind === 'external') { window.open(link.url, '_blank', 'noopener,noreferrer'); return }
        if (link.kind !== 'file') return
        const ref = { kind: 'file' as const, path: link.path, ...(resource.document.kind === 'file' ? { machineId: resource.document.machineId } : {}) }
        if (workspace && pane) workspace.openDocument(pane.paneId, resource, { kind: 'document', sessionId: resource.sessionId, document: ref }, true)
        else void navigate({ to: '/sessions/$sessionId/file', params: { sessionId: resource.sessionId }, search: { path: encodeBase64(link.path), origin: 'chat' } })
    }
    const reference = async () => {
        const selection = session.state.selection
        if (!selection) return
        setReferenceError(undefined)
        try {
            if (session.state.dirty && !await session.save(api)) return
            // Edits made during the save are not part of the saved revision.
            if (session.state.dirty) return
            attachSelection(registry.scope, { id: crypto.randomUUID(), resource, version: session.state.hash,
                targetSessionId: session.state.targetSessionId, selection })
            setAttached(true); session.patch({ selection: undefined })
            const chat = workspace?.get().workspaces.flatMap(w => panes(w.root)).find(p => p.resource.kind === 'chat' && p.resource.sessionId === session.state.targetSessionId)
            if (chat) workspace?.focus(chat.id)
        } catch (error) { setReferenceError(String(error)) }
    }
    const openChat = () => {
        if (workspace?.get().mode === 'workspace') workspace.openSession(state.targetSessionId, 'horizontal')
        else void navigate({ to: '/sessions/$sessionId', params: { sessionId: state.targetSessionId } })
    }
    const compare = async () => {
        const ref = resource.document
        if (ref.kind !== 'file') return
        try {
            const result = await api.readSessionFile(resource.sessionId, ref.path)
            if (!result.success || result.content === undefined || !result.hash) throw new Error(result.error ?? 'Read failed')
            const decoded = decodeDocumentText(base64Bytes(result.content))
            if (!decoded) throw new Error('Disk file is no longer UTF-8 text')
            setDisk({ text: decoded.text, hash: result.hash, format: decoded.format })
        } catch (error) { setReferenceError(String(error)) }
    }
    const adoptDisk = async (keepDraft: boolean) => {
        if (!disk) return
        session.editorState = undefined
        session.patch({ baseText: disk.text, hash: disk.hash, text: keepDraft ? state.text : disk.text,
            dirty: keepDraft && state.text !== disk.text, format: disk.format, writable: !disk.format.mixed,
            conflict: false, error: undefined, selection: undefined })
        await session.persist().catch(error => setReferenceError(String(error)))
        setDisk(undefined); setEditorRevision(value => value + 1)
    }
    const download = async () => {
        if (!state.blob && !state.preview && !state.dirty) return
        setDownloading(true); setReferenceError(undefined)
        try {
            let blob = state.dirty ? new Blob([encodeDocumentText(state.text, state.format) as Uint8Array<ArrayBuffer>]) : state.blob!
            if (office) {
                const ref = resource.document
                if (ref.kind === 'artifact') blob = await api.getArtifactBlob(resource.sessionId, ref.artifactId)
                else {
                    const result = await api.readSessionFile(resource.sessionId, ref.path)
                    if (!result.success || result.content === undefined) throw new Error(result.error ?? 'Download failed')
                    blob = new Blob([base64Bytes(result.content) as Uint8Array<ArrayBuffer>])
                }
            }
            const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (error) { setReferenceError(String(error)) }
        finally { setDownloading(false) }
    }
    const selectMarkdown = (root: HTMLElement) => {
        const selection = window.getSelection()
        if (!selection?.rangeCount || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
        const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement
        const start = element(selection.getRangeAt(0).startContainer)?.closest<HTMLElement>('[data-source-from]')
        const end = element(selection.getRangeAt(0).endContainer)?.closest<HTMLElement>('[data-source-to]')
        if (!start || !end) return
        const from = Number(start.dataset.sourceFrom), to = Number(end.dataset.sourceTo)
        select({ kind: 'text', from, to, lineStart: state.text.slice(0, from).split('\n').length,
            lineEnd: state.text.slice(0, to).split('\n').length, quote: selection.toString().slice(0, 12000), precision: 'block' })
    }
    return <section className="document-surface" aria-label={name} data-document-state={state.phase}>
        <div className="document-toolbar">
            {onBack ? <button onClick={() => state.dirty || state.saving ? setLeaving(true) : onBack()} aria-label={labels.back}>←</button> : null}
            <strong title={resource.document.kind === 'file' ? resource.document.path : name}>{name}</strong>
            <span className="document-status">{state.saving ? labels.saving : state.dirty ? labels.unsaved : state.writable ? labels.saved : labels.readOnly}</span>
            <button aria-pressed={state.pinned} onClick={() => session.patch({ pinned: !state.pinned })}>{state.pinned ? labels.pinned : labels.pin}</button>
            <button onClick={() => void session.load(api, true)}>{labels.reload}</button>
            {markdown || html ? <button onClick={() => { select(undefined); session.patch({ mode: state.mode === 'preview' ? 'edit' : 'preview' }) }}>{state.mode === 'preview' ? html ? labels.source : labels.edit : labels.preview}</button> : null}
            {!office && !sheet && state.mode === 'edit' ? <button onClick={() => setFind(value => value + 1)}>{labels.find}</button> : null}
            {state.writable ? <button className="document-primary" disabled={!state.dirty || state.saving} onClick={() => void session.save(api)}>{state.saving ? labels.saving : labels.save}</button> : null}
            <button disabled={(!state.blob && !state.preview && !state.dirty) || downloading} onClick={() => void download()}>{downloading ? labels.loading : state.dirty ? labels.downloadDraft : labels.download}</button>
        </div>
        {state.error || state.persistenceError || referenceError ? <div className="document-notice" role="alert">{state.error || state.persistenceError || referenceError} <button onClick={() => void session.load(api, true)}>{labels.reload}</button></div> : null}
        {state.conflict ? <div className="document-notice">{labels.conflict} <button onClick={() => void compare()}>{labels.compare}</button></div> : null}
        {state.format.mixed && state.mode === 'edit' ? <div className="document-notice">{labels.mixedEndings}</div> : null}
        {state.changedOnDisk ? <div className="document-notice" role="status">{labels.changedOnDisk}</div> : null}
        {disk ? <div className="document-conflict"><div><h3>{labels.original}</h3><pre>{state.baseText}</pre></div><div><h3>{labels.edit}</h3><pre>{state.text}</pre></div><div><h3>{labels.diskVersion}</h3><pre>{disk.text}</pre></div>
            <button onClick={() => void adoptDisk(false)}>{labels.useDisk}</button><button onClick={() => void adoptDisk(true)}>{labels.keepMine}</button><button onClick={() => setDisk(undefined)}>{labels.cancel}</button></div> : null}
        <div className="document-body">
            {!office && (state.phase === 'loading' || state.phase === 'idle') ? <p role="status">{labels.loading}</p> : null}
            {(office && foreground && state.phase !== 'error') || (state.phase === 'ready' && (state.blob || state.preview || state.dirty)) ? <Suspense fallback={<p role="status">{office ? labels.conversion : labels.loading}</p>}>
                {html && state.textual ? <HtmlDocument session={session} api={api} visible={state.mode === 'preview'} foreground={foreground} onSelect={select} onLink={openHtmlLink} /> : null}
                {office || mime === 'application/pdf' ? <PdfDocument session={session} foreground={foreground} office={office} onSelect={select} />
                    : sheet ? <SheetDocument key={state.contentRevision} blob={state.blob!} session={session} foreground={foreground} onSelect={select} />
                    : mime.startsWith('image/') ? <ImageDocument key={state.contentRevision} blob={state.blob!} onSelect={select} />
                    : markdown && state.textual && state.mode === 'preview' ? <div ref={preview} className="document-markdown" onScroll={event => { session.previewScrollTop = event.currentTarget.scrollTop }} onPointerUp={event => selectMarkdown(event.currentTarget)} onKeyUp={event => selectMarkdown(event.currentTarget)}>
                        <MarkdownRenderer content={state.text} standalone components={markdownBlocks} />
                    </div> : html && state.textual && state.mode === 'preview' ? null : html && (state.blob?.size ?? 0) > MAX_EDITABLE_FILE_BYTES ? <p>{labels.sourceTooLarge}</p> : state.textual ? <DocumentEditor key={`${editorRevision}:${state.contentRevision}:${state.writable}`} session={session} onSave={() => void session.save(api)} findRevision={find} /> : <p>{labels.binary}</p>}
            </Suspense> : null}
        </div>
        {state.selection ? <aside className="document-selection" aria-label={labels.quote}>
            <div><strong>{labels.target} · {target ? getSessionTitle(target) : state.targetSessionId.slice(0, 8)}</strong><p>{state.selection.quote || (state.selection.kind === 'page' ? `${labels.pages} ${state.selection.page}` : '')}</p></div>
            <button disabled={state.saving} onClick={() => void reference()}>{state.dirty ? labels.saveReference : labels.request}</button>
            <button onClick={() => select(undefined)}>{labels.clear}</button>
        </aside> : null}
        {attached ? <div className="document-notice" role="status">{labels.draftAttached} <button onClick={openChat}>{labels.openChat}</button></div> : null}
        <DocumentLeavePrompt request={leaving ? { sessions: [session], finish: leave => { setLeaving(false); if (leave) onBack?.() } } : undefined} />
    </section>
}
