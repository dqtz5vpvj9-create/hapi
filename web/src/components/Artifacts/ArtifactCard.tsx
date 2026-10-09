import { artifactDocumentRef, useOpenDocument } from '@/documents/openDocument'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ArtifactRef } from '@hapi/protocol/artifacts'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { ImagePreview } from '@/components/ImagePreview'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { CodeBlock } from '@/components/CodeBlock'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import { isolatedHtml, parseCsvPreview } from './documentPreview'
import { useDocumentLabels } from '@/documents/labels'

const PdfPreview = lazy(() => import('./PdfArtifactPreview'))

export function ArtifactCard({ artifact, previewUrl, legacyImageId }: {
    artifact: ArtifactRef; previewUrl?: string; legacyImageId?: string
}) {
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const documentLabels = useDocumentLabels()
    const openDocument = useOpenDocument(ctx?.sessionId)
    const documentCard = !!openDocument && !artifact.externalUrl && /\.(?:pdf|pptx?|docx?|xlsx?|xlsm|od[stp]|md|txt|csv|json|html?)$/i.test(artifact.fileName)
    const safePreviewUrl = previewUrl && /^(https?:\/\/|blob:|data:(image|audio|video)\/)/i.test(previewUrl) ? previewUrl : undefined
    const container = useRef<HTMLDivElement>(null)
    const [visible, setVisible] = useState(false)
    const [load, setLoad] = useState(false)
    const [retry, setRetry] = useState(0)
    const [blob, setBlob] = useState<Blob | null>(null)
    const [url, setUrl] = useState<string | null>(safePreviewUrl ?? null)
    const [text, setText] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState(false)
    const [source, setSource] = useState(false)
    const [downloading, setDownloading] = useState(false)
    const mime = blob?.type && blob.type !== 'application/octet-stream' ? blob.type : artifact.mimeType
    const image = mime.startsWith('image/')
    const shouldLoad = load || (artifact.mimeType.startsWith('image/') && visible)
    useEffect(() => {
        if (!container.current) return
        if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
        }, { rootMargin: '200px' })
        observer.observe(container.current)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        setBlob(null); setText(null); setError(null); setUrl(safePreviewUrl ?? null)
        if (!shouldLoad || safePreviewUrl || artifact.externalUrl || !ctx) return
        let disposed = false
        let objectUrl: string | undefined
        const controller = new AbortController()
        const pending = legacyImageId ? ctx.api.getGeneratedImageBlob(ctx.sessionId, legacyImageId)
            : ctx.api.getArtifactBlob(ctx.sessionId, artifact.id, controller.signal)
        void pending.then(async value => {
            if (disposed) return
            setBlob(value)
            if (value.type === 'image/svg+xml') {
                // A data URL has an opaque origin if opened separately; an SVG
                // blob URL would inherit HAPI's origin outside the <img> element.
                const reader = new FileReader()
                reader.onload = () => { if (!disposed) setUrl(String(reader.result)) }
                reader.readAsDataURL(value)
            } else {
                objectUrl = URL.createObjectURL(value)
                setUrl(objectUrl)
            }
            if (value.type.startsWith('text/') || value.type === 'application/json' || artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json') {
                const content = await value.text()
                if (!disposed) setText(content)
            }
        }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
        return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
    }, [ctx?.api, ctx?.sessionId, artifact.id, artifact.mimeType, artifact.externalUrl, safePreviewUrl, legacyImageId, shouldLoad, retry])
    const downloadUrl = artifact.externalUrl ?? url
    const download = () => {
        if (!blob) return
        const address = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
        const anchor = document.createElement('a')
        anchor.href = address; anchor.download = artifact.fileName
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(address), 0)
    }
    const displayUrl = artifact.externalUrl ?? url
    const downloadDocument = async () => {
        if (!ctx || downloading) return
        setDownloading(true); setError(null)
        try {
            const value = await ctx.api.getArtifactBlob(ctx.sessionId, artifact.id)
            const address = URL.createObjectURL(new Blob([value], { type: 'application/octet-stream' }))
            const anchor = document.createElement('a'); anchor.href = address; anchor.download = artifact.fileName; anchor.click()
            setTimeout(() => URL.revokeObjectURL(address), 1000)
        } catch (reason) { setError(String(reason)) }
        finally { setDownloading(false) }
    }
    const preview = () => {
        if (!displayUrl) return null
        if (image) return <ImagePreview frame="artifact" src={displayUrl} fileName={artifact.fileName} label={artifact.fileName}
            buttonClassName="block max-w-full cursor-zoom-in" imageClassName="max-h-[60vh] max-w-full rounded-lg object-contain" />
        if (mime.startsWith('video/')) return <video src={displayUrl} controls playsInline preload="metadata" onError={() => setError(t('artifact.codecError'))} className="max-h-[60vh] w-full rounded-lg" />
        if (mime.startsWith('audio/')) return <audio src={displayUrl} controls preload="metadata" onError={() => setError(t('artifact.codecError'))} className="w-full" />
        if (mime === 'application/pdf' && blob) return <Suspense fallback={<p>{t('artifact.loading')}</p>}><PdfPreview blob={blob} /></Suspense>
        if (mime === 'text/html' && text !== null) return source
            ? <CodeBlock code={text.slice(0, 200_000)} language="html" />
            : <iframe title={artifact.fileName} srcDoc={isolatedHtml(text)} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[60vh] w-full rounded-lg border bg-white" />
        if (mime === 'text/markdown' && text !== null) return <MarkdownRenderer content={text.slice(0, 200_000)} standalone />
        if (mime === 'text/csv' && text !== null) return <div className="max-h-96 overflow-auto"><table className="text-sm"><tbody>{parseCsvPreview(text).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className="max-w-80 border px-2 py-1 break-words">{cell}</td>)}</tr>)}</tbody></table><p className="text-xs">{t('artifact.csvLimit')}</p></div>
        if (text !== null) {
            let content = text.slice(0, 200_000)
            if (mime === 'application/json' && text.length < 200_000) { try { content = JSON.stringify(JSON.parse(text), null, 2) } catch { /* show original */ } }
            return <CodeBlock code={content} language={mime === 'application/json' ? 'json' : 'text'} />
        }
        return <p className="text-sm text-[var(--app-hint)]">{t('artifact.downloadOnly')}</p>
    }
    if (documentCard) return <div className="my-2 flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-[var(--app-border)] px-3 py-2" data-document-card={artifact.id}>
        <span aria-hidden="true">▤</span><button className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => void openDocument!(artifactDocumentRef(artifact))}>{artifact.fileName}</button>
        <button className="shrink-0 text-sm text-[var(--app-link)]" onClick={() => void openDocument!(artifactDocumentRef(artifact))}>{t('artifact.preview')}</button>
        <button disabled={downloading} className="shrink-0 text-sm text-[var(--app-link)]" onClick={() => void downloadDocument()}>{downloading ? t('artifact.loading') : t('artifact.download')}</button>
        {error ? <p role="alert" className="w-full text-xs text-[var(--app-hint)]">{error}</p> : null}
    </div>
    return <div ref={container} data-hapi-share-media-state={error ? 'error' : displayUrl ? 'ready' : 'loading'} className="my-2 min-w-0 max-w-full space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] p-3">
        <div className="flex items-center gap-2 text-sm">
            <span title={artifact.fileName} className="min-w-0 flex-1 truncate font-medium">{artifact.label ? `${artifact.label} · ` : ''}{artifact.fileName}</span>
            {!downloadUrl && !blob ? <button disabled className="text-[var(--app-hint)]">{t('artifact.download')}</button> : null}
            {blob ? <button onClick={download} className="text-[var(--app-link)]">{t('artifact.download')}</button> : downloadUrl ? <a href={downloadUrl} download={artifact.fileName} target="_blank" rel="noreferrer" className="text-[var(--app-link)]">{t('artifact.download')}</a> : null}
            {(mime === 'text/html' || mime === 'application/pdf') ? <button disabled={!displayUrl} onClick={() => setExpanded(true)}>{t('artifact.expand')}</button> : null}
            {mime === 'text/html' ? <button disabled={text === null} onClick={() => setSource(value => !value)}>{t(source ? 'artifact.preview' : 'artifact.source')}</button> : null}
            {image && openDocument && !artifact.externalUrl && !legacyImageId ? <button onClick={() => void openDocument(artifactDocumentRef(artifact))}>{documentLabels.openPane}</button> : null}
        </div>

        {image ? <div className="relative"><ImagePreview frame="artifact" src={displayUrl ?? ''} fileName={artifact.fileName} label={artifact.fileName}
            loadingLabel={error ?? t('artifact.loading')} errorLabel={t('artifact.imageError')}
            buttonClassName="block max-w-full cursor-zoom-in rounded-lg" />
            {error ? <button className="absolute bottom-3 left-3 text-sm text-[var(--app-link)]" onClick={() => { setError(null); setRetry(value => value + 1) }}>{t('artifact.retry')}</button> : null}
        </div> : <div className={shouldLoad || displayUrl ? (mime.startsWith('audio/') ? 'hapi-audio-preview' : 'hapi-document-preview') : undefined}>
        {error && !image ? <div role="alert" className="text-sm text-[var(--app-hint)]">{error} <button onClick={() => { setError(null); setLoad(true); setRetry(value => value + 1) }}>{t('artifact.retry')}</button></div> : null}
        {displayUrl ? preview() : error ? null : shouldLoad ? <div className="flex min-h-32 items-center justify-center text-sm">{t('artifact.loading')}</div>
            : <button className="min-h-12 w-full rounded-lg bg-[var(--app-subtle-bg)] text-sm" onClick={() => setLoad(true)}>{t('artifact.load')}</button>}
        </div>}
        {mime === 'text/html' ? <p className="text-xs text-[var(--app-hint)]">{t('artifact.htmlIsolation')}</p> : null}
        <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-h-[95dvh] max-w-5xl overflow-auto"><DialogHeader><DialogTitle>{artifact.fileName}</DialogTitle></DialogHeader>{preview()}</DialogContent></Dialog>
    </div>
}
