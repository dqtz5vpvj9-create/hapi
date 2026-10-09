import { useEffect, useRef, useState } from 'react'
import { HtmlPreviewMessageSchema, type DocumentSelection } from '@hapi/protocol/documents'
import type { ApiClient } from '@/api/client'
import { HtmlPreview, resolveHtmlLink, type HtmlLink } from './htmlPreview'
import type { DocumentSession } from './documentSession'
import { useDocumentLabels } from './labels'

export default function HtmlDocument({ session, api, visible, foreground, onSelect, onLink }: {
    session: DocumentSession; api: ApiClient; visible: boolean; foreground: boolean
    onSelect: (selection: DocumentSelection | undefined) => void; onLink: (link: HtmlLink) => void
}) {
    const labels = useDocumentLabels()
    const frame = useRef<HTMLIFrameElement>(null)
    const callbacks = useRef({ onSelect, onLink, foreground, visible })
    callbacks.current = { onSelect, onLink, foreground, visible }
    const [preview, setPreview] = useState<HtmlPreview>()
    const [source, setSource] = useState<string>()
    const [ready, setReady] = useState(false)
    const [notices, setNotices] = useState<string[]>([])
    const [error, setError] = useState<string>()
    const text = session.state.text, revision = session.state.contentRevision
    useEffect(() => {
        if (!visible || !foreground) return
        if (session.htmlPreview?.source !== text || session.htmlPreview.revision !== revision) {
            const previous = session.htmlPreview
            session.htmlPreview = new HtmlPreview(text, revision, session.resource, api)
            if (previous?.source === text) session.htmlPreview.viewState = previous.viewState
        }
        setPreview(session.htmlPreview)
    }, [session, api, text, revision, visible, foreground])
    useEffect(() => {
        if (!preview) return
        let disposed = false
        setReady(false); setError(undefined); setNotices([])
        void preview.html().then(html => { if (!disposed) setSource(html) }).catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true }
    }, [preview])
    useEffect(() => {
        if (!preview) return
        let disposed = false
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.current?.contentWindow) return
            const parsed = HtmlPreviewMessageSchema.safeParse(event.data)
            if (!parsed.success || parsed.data.id !== preview.id) return
            const message = parsed.data
            if (message.type === 'ready') {
                setReady(true)
                setNotices([...preview.notices])
            } else if (message.type === 'media') {
                void preview.loadMedia(message.resource, resource => {
                    if (!disposed) frame.current?.contentWindow?.postMessage({ type: 'resource', id: preview.id, resource: resource.id, attribute: resource.attribute, url: resource.url }, '*')
                }).then(() => { if (!disposed) setNotices([...preview.notices]) })
            } else if (message.type === 'state') preview.viewState = message.state
            else if (callbacks.current.visible && callbacks.current.foreground) {
                if (message.type === 'selection') callbacks.current.onSelect(message.selection)
                else if (message.type === 'link') {
                    const ref = session.resource.document
                    const link = resolveHtmlLink(message.href, ref.kind === 'file' ? ref.path : undefined)
                    if (link) callbacks.current.onLink(link)
                    else setError(`${labels.unavailableLink}: ${message.href}`)
                }
            }
        }
        window.addEventListener('message', receive)
        return () => { disposed = true; window.removeEventListener('message', receive) }
    }, [preview, session, labels.unavailableLink])
    useEffect(() => {
        if (preview && (!visible || !foreground)) frame.current?.contentWindow?.postMessage({ type: 'capture-state', id: preview.id }, '*')
    }, [preview, visible, foreground])
    useEffect(() => {
        if (!session.state.selection && preview) frame.current?.contentWindow?.postMessage({ type: 'clear-selection', id: preview.id }, '*')
    }, [session.state.selection, preview])
    return <div className="document-html" hidden={!visible} data-html-state={error ? 'error' : ready ? 'ready' : 'loading'}>
        {error ? <div className="document-notice" role="alert">{error}</div> : null}
        {notices.length ? <details className="document-notice"><summary>{labels.unavailableResources} ({notices.length})</summary><ul>{notices.map(path => <li key={path}>{path}</li>)}</ul></details> : null}
        {!ready && !error ? <p role="status">{labels.loading}</p> : null}
        {source ? <iframe ref={frame} title={labels.preview} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer" className="document-html-frame" /> : null}
    </div>
}
