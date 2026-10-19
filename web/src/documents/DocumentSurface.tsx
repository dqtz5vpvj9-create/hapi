import { createElement, lazy, Suspense, useEffect, useMemo, useRef, useState, useLayoutEffect, useSyncExternalStore, type HTMLAttributes } from 'react'
import type { ExtraProps } from 'react-markdown'
import * as Popover from '@radix-ui/react-popover'
import { documentKey, documentName, MAX_EDITABLE_FILE_BYTES, type DocumentResource, type DocumentSelection } from '@hapi/protocol/documents'
import { artifactMimeFromFilename } from '@hapi/protocol/artifacts'
import { useAppContext } from '@/lib/app-context'
import { panes } from '@/workspace/workspaceStore'
import { usePaneEditing, usePane } from '@/workspace/PaneContext'
import { encodeBase64 } from '@/lib/utils'
import type { HtmlLink } from './htmlPreview'
import { useSession } from '@/hooks/queries/useSession'
import { usePaneNavigate } from '@/workspace/PaneContext'
import { getSessionTitle } from '@/lib/sessionTitle'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { base64Bytes, decodeDocumentText, encodeDocumentText, type TextFormat } from './documentSession'
import { useDocumentRegistry } from './useDocumentRegistry'
import { useFileWorkbenchNavigation } from '@/file-workbench/context'
import { DocumentLeavePrompt } from './DocumentLeaveDialog'
import { DocumentEditor } from './DocumentEditor'
import { attachSelection } from './selectionDrafts'
import { useDocumentLabels } from './labels'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { fileManagerTargetFromPath } from '@/lib/session-files-navigation'
import './documents.css'

const PdfDocument = lazy(() => import('./PdfDocument'))
const SheetDocument = lazy(() => import('./SheetDocument'))
const ImageDocument = lazy(() => import('./ImageDocument'))
const HtmlDocument = lazy(() => import('./HtmlDocument'))
const markdownBlocks = Object.fromEntries(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'pre'].map(tag => [tag,
    ({ node, ...props }: HTMLAttributes<HTMLElement> & ExtraProps) => createElement(tag, { ...props,
        'data-source-from': node?.position?.start.offset, 'data-source-to': node?.position?.end.offset }),
]))

export function DocumentSurface({ resource, foreground = true, onBack, onClose, onCloseOthers }: {
    resource: DocumentResource; foreground?: boolean; onBack?: () => void; onClose?: () => void; onCloseOthers?: () => void
}) {
    const { api, workspace } = useAppContext()
    const labels = useDocumentLabels()
    const navigate = usePaneNavigate()
    const pane = usePane()
    const registry = useDocumentRegistry()
    const fileWorkbench = useFileWorkbenchNavigation()
    const pathClipboard = useCopyToClipboard()
    const session = useMemo(() => registry.get(resource), [registry, documentKey(resource)])
    const state = useSyncExternalStore(session.subscribe, session.get)
    usePaneEditing(state.dirty || state.saving)
    // File bytes and undo state are shared by physical identity. A workbench's
    // reference destination belongs to its own conversation, not the first
    // conversation that happened to load the same file.
    const targetSessionId = fileWorkbench?.sessionId === resource.sessionId ? resource.sessionId : state.targetSessionId
    const { session: target } = useSession(api, targetSessionId)
    const { session: sourceSession } = useSession(api, resource.sessionId)
    const preview = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        if (preview.current) preview.current.scrollTop = session.previewScrollTop
        return () => { if (preview.current) session.previewScrollTop = preview.current.scrollTop }
    }, [session, state.mode, state.phase])
    const [find, setFind] = useState(0)
    const findTakesFocus = useRef(false)
    const [pathOpen, setPathOpen] = useState(false)
    const [actionsOpen, setActionsOpen] = useState(false)
    const foregroundRef = useRef(foreground)
    foregroundRef.current = foreground
    const [attached, setAttached] = useState(false)
    const [referenceError, setReferenceError] = useState<string>()
    const [disk, setDisk] = useState<{ text: string; hash: string; format: TextFormat }>()
    const [leaving, setLeaving] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const [editorRevision, setEditorRevision] = useState(0)
    const name = documentName(resource.document)
    const filePath = resource.document.kind === 'file' ? resource.document.path : undefined
    const revealFile = () => {
        if (!filePath) return
        if (fileWorkbench?.sessionId === resource.sessionId) fileWorkbench.reveal(filePath)
        else void navigate({ to: '/sessions/$sessionId/files', params: { sessionId: resource.sessionId }, search: { tab: 'directories', target: fileManagerTargetFromPath(filePath, sourceSession?.metadata?.path) } })
    }
    const extension = name.split('.').at(-1)?.toLowerCase()
    const office = /^(pptx?|docx?|od[tp])$/.test(extension ?? '')
    const sheet = /^(xlsx?|xlsm|ods)$/.test(extension ?? '')
    const markdown = /^(md|markdown|mdx)$/.test(extension ?? '')
    const html = /^(html|htm)$/.test(extension ?? '')
    const mime = artifactMimeFromFilename(name)
    const textEditorFormat = state.textual && !office && !sheet
        && mime !== 'application/pdf' && !mime.startsWith('image/')
        && !(html && (state.blob?.size ?? 0) > MAX_EDITABLE_FILE_BYTES)
    const editorVisible = state.phase === 'ready' && textEditorFormat && !((markdown || html) && state.mode === 'preview')
    // PDF bytes can happen to decode as UTF-8. Filesystem write permission
    // alone does not make the rendered document an editable source surface.
    const writableDocument = state.writable && (textEditorFormat || state.dirty)
    const status = state.saving ? labels.saving : state.dirty ? labels.unsaved : writableDocument ? labels.saved : labels.readOnly
    const showModeAction = (markdown || html) && state.mode === 'preview' && !state.dirty
    const toggleMode = () => { select(undefined); session.patch({ mode: state.mode === 'preview' ? 'edit' : 'preview' }) }
    const back = () => filePath ? revealFile() : onBack?.()
    const requestBack = () => {
        // Revealing a file in its own workbench keeps the reader and draft
        // mounted. A standalone reader still asks before leaving dirty work.
        if (filePath && fileWorkbench?.sessionId === resource.sessionId) revealFile()
        else if (state.dirty || state.saving) setLeaving(true)
        else back()
    }
    const copyPath = async () => {
        if (!filePath) return
        setReferenceError(undefined)
        if (!await pathClipboard.copy(filePath)) setReferenceError(labels.pathCopyFailed)
    }
    useEffect(() => {
        if (!foreground) { setPathOpen(false); setActionsOpen(false) }
    }, [foreground])
    useEffect(() => {
        session.users++
        return () => { session.users--; registry.trim() }
    }, [session, registry])
    useEffect(() => { if (foreground) void session.load(api, false, resource.sessionId) }, [session, api, foreground, resource.sessionId])
    useEffect(() => {
        // A successful create/upload can replace a file whose clean reader is
        // already mounted. Only explicit invalidation retries it automatically;
        // errors still wait for Reload instead of entering a request loop.
        if (foreground && state.phase === 'idle' && !state.fileOperation) void session.load(api, false, resource.sessionId)
    }, [session, api, foreground, resource.sessionId, state.phase, state.fileOperation])
    useEffect(() => {
        if (!foreground || state.phase !== 'ready') return
        const check = () => { if (document.visibilityState !== 'hidden') void session.checkUpdates(api, resource.sessionId) }
        check()
        const interval = setInterval(check, 20000)
        window.addEventListener('online', check); document.addEventListener('visibilitychange', check)
        return () => { clearInterval(interval); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', check) }
    }, [session, api, foreground, state.phase, resource.sessionId])
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
        if (fileWorkbench?.sessionId === resource.sessionId) fileWorkbench.open(ref)
        else if (workspace && pane) workspace.openDocument(pane.paneId, resource, { kind: 'document', sessionId: resource.sessionId, document: ref }, true)
        else void navigate({ to: '/sessions/$sessionId/file', params: { sessionId: resource.sessionId }, search: { path: encodeBase64(link.path), origin: 'chat' } })
    }
    const reference = async () => {
        const selection = session.state.selection
        if (!selection) return
        setReferenceError(undefined)
        try {
            if (session.state.dirty && !await session.save(api, resource.sessionId)) return
            // Edits made during the save are not part of the saved revision.
            if (session.state.dirty) return
            attachSelection(registry.scope, { id: crypto.randomUUID(), resource, version: session.state.hash,
                targetSessionId, selection })
            setAttached(true); session.patch({ selection: undefined })
            const chat = workspace?.get().workspaces.flatMap(w => panes(w.root)).find(p => p.resource.kind === 'chat' && p.resource.sessionId === targetSessionId)
            if (chat) workspace?.focus(chat.id)
        } catch (error) { setReferenceError(String(error)) }
    }
    const openChat = () => {
        if (workspace?.get().mode === 'workspace') workspace.openSession(targetSessionId, 'horizontal')
        else void navigate({ to: '/sessions/$sessionId', params: { sessionId: targetSessionId } })
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
    const heading = <span className="document-title-row">
        <strong title={name}>{name}</strong>
        {state.dirty ? <span className="document-dirty-indicator" aria-hidden="true" /> : null}
        <span className={`document-status${writableDocument || state.dirty || state.saving ? '' : ' document-status-passive'}`}
            data-dirty={state.dirty || undefined} aria-live="polite" title={status}>{status}</span>
    </span>
    return <section className="document-surface" aria-label={name} data-document-state={state.phase}>
        <div className="document-toolbar">
            {filePath || onBack ? <button type="button" className="document-icon-button" onClick={requestBack}
                aria-label={filePath ? labels.backToTree : labels.back} title={filePath ? labels.backToTree : labels.back}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
            </button> : null}
            {filePath ? <Popover.Root open={foreground && pathOpen} onOpenChange={setPathOpen}>
                    <Popover.Trigger asChild><button type="button" className="document-heading document-heading-button" aria-label={labels.filePath} title={filePath}>
                        {heading}
                        <span className="document-path-row">
                            <code>{filePath}</code>
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
                        </span>
                    </button></Popover.Trigger>
                    <Popover.Portal><Popover.Content className="document-popover document-path-popover" side="bottom" align="start" sideOffset={8} collisionPadding={12} aria-label={labels.filePath}
                        onCloseAutoFocus={event => { if (!foregroundRef.current) event.preventDefault() }}>
                        <p className="document-popover-label">{labels.filePath}</p>
                        <code tabIndex={0} className="document-full-path">{filePath}</code>
                        <button type="button" className="document-popover-copy" onClick={() => void copyPath()}>
                            {pathClipboard.copied ? <CheckIcon /> : <CopyIcon />}{pathClipboard.copied ? labels.pathCopied : labels.copyPath}
                        </button>
                    </Popover.Content></Popover.Portal>
                </Popover.Root> : <div className="document-heading">{heading}</div>}
            {filePath ? <button type="button" className="document-icon-button document-copy-path" aria-label={labels.copyPath} title={pathClipboard.copied ? labels.pathCopied : labels.copyPath}
                onClick={() => void copyPath()}>{pathClipboard.copied ? <CheckIcon /> : <CopyIcon />}</button> : null}
            {showModeAction ? <button type="button" className="document-mode-action" onClick={toggleMode}>{html ? labels.source : labels.edit}</button> : null}
            {writableDocument && !showModeAction ? <button type="button" className="document-primary document-save" aria-label={labels.save}
                disabled={!state.dirty || state.saving || state.fileOperation} onClick={() => void session.save(api, resource.sessionId)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8" /></svg><span>{labels.save}</span>
            </button> : null}
            <Popover.Root open={foreground && actionsOpen} onOpenChange={setActionsOpen}>
                <Popover.Trigger asChild><button type="button" className="document-icon-button" aria-label={labels.actions} title={labels.actions}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
                </button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="document-popover document-action-menu" side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label={labels.actions}
                    onCloseAutoFocus={event => {
                        if (!foregroundRef.current || findTakesFocus.current) event.preventDefault()
                        findTakesFocus.current = false
                    }}>
                    <div className="document-popover-label"><span className="document-menu-name">{name}</span><span className="document-menu-status">{status}</span></div>
                    {markdown || html ? <Popover.Close asChild><button type="button" onClick={toggleMode}>{state.mode === 'preview' ? html ? labels.source : labels.edit : labels.preview}</button></Popover.Close> : null}
                    {editorVisible ? <Popover.Close asChild><button type="button" onClick={() => { findTakesFocus.current = true; setFind(value => value + 1) }}>{labels.find}</button></Popover.Close> : null}
                    <Popover.Close asChild><button type="button" disabled={state.fileOperation} onClick={() => void session.load(api, true, resource.sessionId)}>{labels.reload}</button></Popover.Close>
                    <Popover.Close asChild><button type="button" disabled={(!state.blob && !state.preview && !state.dirty) || downloading} onClick={() => void download()}>{downloading ? labels.loading : state.dirty ? labels.downloadDraft : labels.download}</button></Popover.Close>
                    <div className="document-menu-divider" />
                    <Popover.Close asChild><button type="button" aria-pressed={state.pinned} onClick={() => session.patch({ pinned: !state.pinned })}>
                        <span>{state.pinned ? labels.pinned : labels.pin}</span>{state.pinned ? <CheckIcon /> : null}
                    </button></Popover.Close>
                    {onClose || onCloseOthers ? <div className="document-menu-divider" /> : null}
                    {onCloseOthers ? <Popover.Close asChild><button type="button" onClick={onCloseOthers}>{labels.closeOthers}</button></Popover.Close> : null}
                    {onClose ? <Popover.Close asChild><button type="button" onClick={onClose}>{labels.closeFile}</button></Popover.Close> : null}
                </Popover.Content></Popover.Portal>
            </Popover.Root>
            <span role="status" className="sr-only">{pathClipboard.copied ? labels.pathCopied : ''}</span>
        </div>
        {state.error || state.persistenceError || referenceError ? <div className="document-notice" role="alert">{state.error || state.persistenceError || referenceError} <button disabled={state.fileOperation} onClick={() => void session.load(api, true, resource.sessionId)}>{labels.reload}</button></div> : null}
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
                    </div> : html && state.textual && state.mode === 'preview' ? null : html && (state.blob?.size ?? 0) > MAX_EDITABLE_FILE_BYTES ? <p>{labels.sourceTooLarge}</p> : state.textual ? <DocumentEditor key={`${editorRevision}:${state.contentRevision}:${state.writable}`} session={session} onSave={() => void session.save(api, resource.sessionId)} findRevision={find} /> : <p>{labels.binary}</p>}
            </Suspense> : null}
        </div>
        {state.selection ? <aside className="document-selection" aria-label={labels.quote}>
            <div><strong>{labels.target} · {target ? getSessionTitle(target) : targetSessionId.slice(0, 8)}</strong><p>{state.selection.quote || (state.selection.kind === 'page' ? `${labels.pages} ${state.selection.page}` : '')}</p></div>
            <button disabled={state.saving} onClick={() => void reference()}>{state.dirty ? labels.saveReference : labels.request}</button>
            <button onClick={() => select(undefined)}>{labels.clear}</button>
        </aside> : null}
        {attached ? <div className="document-notice" role="status">{labels.draftAttached} <button onClick={openChat}>{labels.openChat}</button></div> : null}
        <DocumentLeavePrompt request={leaving ? { sessions: [session], sessionId: resource.sessionId, finish: leave => { setLeaving(false); if (leave) back() } } : undefined} />
    </section>
}
