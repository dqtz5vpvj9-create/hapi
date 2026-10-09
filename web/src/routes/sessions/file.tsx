import { DocumentSurface } from '@/documents/DocumentSurface'
import { DocumentRefSchema } from '@hapi/protocol/documents'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearch } from '@tanstack/react-router'
import type { GitCommandResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { CopyIcon, CheckIcon, WrapIcon } from '@/components/icons'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { formatReadFileError } from '@/lib/files-i18n'
import { queryKeys } from '@/lib/query-keys'
import { langAlias, useShikiHighlighter } from '@/lib/shiki'
import { useTranslation } from '@/lib/use-translation'
import { decodeBase64 } from '@/lib/utils'
import { ImagePreview } from '@/components/ImagePreview'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { formatFileMetadata } from '@/lib/file-metadata'
import {
    getInitialMarkdownPreviewMode,
    isMarkdownFile,
    persistMarkdownPreviewMode,
    type MarkdownPreviewMode,
} from '@/lib/file-markdown-preview'
import { downloadBase64File } from '@/lib/file-download'
import { useCodeWrap } from '@/hooks/useCodeWrap'
import { useSession } from '@/hooks/queries/useSession'
import { resolveAbsoluteFilePath } from '@/lib/file-path'
import { useDocumentLabels } from '@/documents/labels'

const MAX_COPYABLE_FILE_BYTES = 1_000_000
const FILE_SCROLL_KEY_PREFIX = 'hapi-file-scroll-'

function getFileScrollStorageKey(sessionId: string, filePath: string, staged: boolean | undefined): string {
    return `${FILE_SCROLL_KEY_PREFIX}${sessionId}:${encodeURIComponent(filePath)}:${staged === true ? 'staged' : 'unstaged'}`
}
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp'
}

function decodePath(value: string): string {
    if (!value) return ''
    const decoded = decodeBase64(value)
    return decoded.ok ? decoded.text : value
}

function DownloadIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
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
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    )
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function DiffDisplay(props: { diffContent: string }) {
    const lines = props.diffContent.split('\n')

    return (
        <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
            {lines.map((line, index) => {
                const isAdd = line.startsWith('+') && !line.startsWith('+++')
                const isRemove = line.startsWith('-') && !line.startsWith('---')
                const isHunk = line.startsWith('@@')
                const isHeader = line.startsWith('+++') || line.startsWith('---')

                const className = [
                    'whitespace-pre-wrap px-3 py-0.5 text-xs font-mono',
                    isAdd ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]' : '',
                    isRemove ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]' : '',
                    isHunk ? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold' : '',
                    isHeader ? 'text-[var(--app-hint)] font-semibold' : ''
                ].filter(Boolean).join(' ')

                const style = isAdd
                    ? { borderLeft: '2px solid var(--app-git-staged-color)' }
                    : isRemove
                        ? { borderLeft: '2px solid var(--app-git-deleted-color)' }
                        : undefined

                return (
                    <div key={`${index}-${line}`} className={className} style={style}>
                        {line || ' '}
                    </div>
                )
            })}
        </div>
    )
}

function FileContentSkeleton(props: { label: string }) {
    const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5']

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            <div className="animate-pulse space-y-2 rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3">
                {Array.from({ length: 12 }).map((_, index) => (
                    <div key={`file-skeleton-${index}`} className={`h-3 ${widths[index % widths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                ))}
            </div>
        </div>
    )
}

function FileContentHeader(props: {
    label: string
    copied: boolean
    copyLabel: string
    onCopy?: () => void
    codeWrap?: boolean
    wrapEnableLabel?: string
    wrapDisableLabel?: string
    onToggleWrap?: () => void
}) {
    const showWrapToggle = props.onToggleWrap !== undefined
        && props.wrapEnableLabel !== undefined
        && props.wrapDisableLabel !== undefined
    const wrapLabel = props.codeWrap ? props.wrapDisableLabel : props.wrapEnableLabel

    return (
        <div
            data-hapi-file-content-header="true"
            className="app-file-code-toolbar flex items-center justify-between gap-3 bg-[var(--app-code-header-bg)] px-3 py-2"
        >
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--app-code-header-fg)]">
                {props.label}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {showWrapToggle ? (
                    <button
                        type="button"
                        data-hapi-code-wrap-toggle="true"
                        data-hapi-wrap-enable-label={props.wrapEnableLabel}
                        data-hapi-wrap-disable-label={props.wrapDisableLabel}
                        onClick={props.onToggleWrap}
                        className={`app-file-icon-action rounded-md p-1 transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)] ${props.codeWrap ? 'text-[var(--app-fg)]' : 'text-[var(--app-code-header-fg)]'}`}
                        title={wrapLabel}
                        aria-label={wrapLabel}
                        aria-pressed={props.codeWrap}
                    >
                        <WrapIcon className="h-3.5 w-3.5" />
                    </button>
                ) : null}
                {props.onCopy ? (
                    <button
                        type="button"
                        onClick={props.onCopy}
                        className="app-file-icon-action rounded-md p-1 text-[var(--app-code-header-fg)] transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)]"
                        title={props.copyLabel}
                        aria-label={props.copyLabel}
                    >
                        {props.copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                ) : null}
            </div>
        </div>
    )
}

function resolveLanguage(path: string): string | undefined {
    const parts = path.split('.')
    if (parts.length <= 1) return undefined
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return undefined
    return langAlias[ext] ?? ext
}

function resolveImageMimeType(path: string): string | null {
    const parts = path.split('.')
    if (parts.length <= 1) return null
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return null
    return IMAGE_MIME_BY_EXTENSION[ext] ?? null
}

function getUtf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length
}

function isBinaryContent(content: string): boolean {
    if (!content) return false
    if (content.includes('\0')) return true
    const nonPrintable = content.split('').filter((char) => {
        const code = char.charCodeAt(0)
        return code < 32 && code !== 9 && code !== 10 && code !== 13
    }).length
    return nonPrintable / content.length > 0.1
}

function extractCommandError(result: GitCommandResponse | undefined): string | null {
    if (!result) return null
    if (result.success) return null
    return result.error ?? result.stderr ?? 'Failed to load diff'
}

export default function FilePage() {
    const { sessionId } = useParams({ from: '/sessions/$sessionId/file' })
    const search = useSearch({ from: '/sessions/$sessionId/file' })
    const goBack = useAppGoBack()
    const { api } = useAppContext()
    const { session, isLoading, error, refetch } = useSession(api, sessionId)
    const labels = useDocumentLabels()
    if (search.staged !== undefined) return <SessionFile sessionId={sessionId} search={search} onBack={goBack} />
    if (isLoading) return <p role="status">{labels.loading}</p>
    if (!session) return <p role="alert">{error} <button onClick={() => void refetch()}>{labels.reload}</button></p>
    if (search.document) {
        try {
            const decoded = decodeBase64(search.document)
            const parsed = decoded.ok ? DocumentRefSchema.safeParse(JSON.parse(decoded.text)) : null
            if (parsed?.success) return <DocumentSurface key={JSON.stringify([sessionId, parsed.data])} resource={{ kind: 'document', sessionId, document: parsed.data }} onBack={goBack} />
        } catch { /* Render the invalid reference rather than fetching an unrelated path. */ }
        return <p role="alert">Invalid document reference</p>
    }
    return <DocumentSurface key={JSON.stringify([sessionId, search.path])} resource={{ kind: 'document', sessionId, document: { kind: 'file', path: resolveAbsoluteFilePath(session.metadata?.path, decodePath(search.path)), machineId: session.metadata?.machineId } }} onBack={goBack} />
}

export function SessionFile(props: { sessionId: string; search: { path?: string; staged?: boolean }; onBack: () => void }) {
    const { api } = useAppContext()
    const { t, locale } = useTranslation()
    const { copied: pathCopied, copy: copyPath } = useCopyToClipboard()
    const { copied: contentCopied, copy: copyContent } = useCopyToClipboard()
    const goBack = props.onBack
    const { sessionId, search } = props
    const encodedPath = typeof search.path === 'string' ? search.path : ''
    const staged = search.staged
    // Project files omit staged; Code changes explicitly passes true or false.
    // Reading a file must not depend on the directory being a Git repository.
    const requestedDiff = staged !== undefined

    const filePath = useMemo(() => decodePath(encodedPath), [encodedPath])
    const fileName = filePath.split('/').pop() || filePath || t('file.page.fallbackName')
    const imageMimeType = useMemo(() => resolveImageMimeType(filePath), [filePath])
    const markdownFile = useMemo(() => isMarkdownFile(filePath), [filePath])

    const diffQuery = useQuery({
        queryKey: queryKeys.gitFileDiff(sessionId, filePath, staged),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.getGitDiffFile(sessionId, filePath, staged)
        },
        enabled: Boolean(requestedDiff && api && sessionId && filePath)
    })

    const fileQuery = useQuery({
        queryKey: queryKeys.sessionFile(sessionId, filePath),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.readSessionFile(sessionId, filePath)
        },
        enabled: Boolean(api && sessionId && filePath)
    })

    const diffContent = requestedDiff && diffQuery.data?.success ? (diffQuery.data.stdout ?? '') : ''
    const diffError = requestedDiff
        ? (extractCommandError(diffQuery.data) ?? (!diffQuery.data ? diffQuery.error?.message : null))
        : null
    const diffSuccess = diffQuery.data?.success === true

    const fileContentResult = fileQuery.data
    const decodedContentResult = fileContentResult?.success && fileContentResult.content
        ? decodeBase64(fileContentResult.content)
        : { text: '', ok: true }
    const decodedContent = decodedContentResult.text
    const binaryFile = fileContentResult?.success
        ? !decodedContentResult.ok || isBinaryContent(decodedContent)
        : false
    const imagePreviewUrl = fileContentResult?.success && fileContentResult.content && imageMimeType
        ? `data:${imageMimeType};base64,${fileContentResult.content}`
        : null

    const language = useMemo(() => imageMimeType ? undefined : resolveLanguage(filePath), [filePath, imageMimeType])
    const [markdownMode, setMarkdownMode] = useState<MarkdownPreviewMode>(getInitialMarkdownPreviewMode)
    const showMarkdownSource = !markdownFile || markdownMode === 'source'
    const highlighted = useShikiHighlighter(
        imageMimeType || (markdownFile && !showMarkdownSource) ? '' : decodedContent,
        language
    )
    const contentSizeBytes = useMemo(
        () => (decodedContent ? getUtf8ByteLength(decodedContent) : 0),
        [decodedContent]
    )
    const canCopyContent = fileContentResult?.success === true
        && !binaryFile
        && decodedContent.length > 0
        && contentSizeBytes <= MAX_COPYABLE_FILE_BYTES

    const canDownload = fileContentResult?.success === true && Boolean(fileContentResult.content)

    const viewKey = JSON.stringify([sessionId, filePath, staged ?? null])
    const [viewSelection, setViewSelection] = useState<{ key: string; mode: 'diff' | 'file' } | null>(null)
    const canShowDiff = requestedDiff && !imageMimeType && !diffError && (!diffSuccess || Boolean(diffContent))
    const displayMode = canShowDiff && (viewSelection?.key !== viewKey || viewSelection.mode === 'diff')
        ? 'diff'
        : 'file'
    const setDisplayMode = (mode: 'diff' | 'file') => setViewSelection({ key: viewKey, mode })
    const loading = displayMode === 'diff' ? diffQuery.isLoading : fileQuery.isLoading
    const { codeWrap, setCodeWrap } = useCodeWrap()
    const fileScrollRef = useRef<HTMLDivElement>(null)
    const restoredScrollKeyRef = useRef<string | null>(null)
    const fileScrollKey = useMemo(
        () => getFileScrollStorageKey(sessionId, filePath, staged),
        [filePath, sessionId, staged]
    )

    const restoreFileScroll = useCallback((element: HTMLDivElement | null = fileScrollRef.current) => {
        if (!element) return
        try {
            const saved = sessionStorage.getItem(fileScrollKey)
            if (saved !== null) element.scrollTop = Number(saved)
        } catch {
            // Ignore unavailable storage.
        }
    }, [fileScrollKey])

    useLayoutEffect(() => {
        restoreFileScroll()
        const frame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(() => restoreFileScroll())
            : undefined
        return () => {
            if (frame !== undefined && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(frame)
            }
            const element = fileScrollRef.current
            if (!element) return
            try {
                sessionStorage.setItem(fileScrollKey, String(element.scrollTop))
            } catch {
                // Ignore unavailable storage.
            }
        }
    }, [fileScrollKey, restoreFileScroll])

    // Query results can arrive after the route first renders. Re-apply the
    // saved position once content has been mounted, but do not overwrite
    // user scrolling when a query refreshes the same file.
    useEffect(() => {
        if (loading) return
        if (restoredScrollKeyRef.current === fileScrollKey) return
        restoreFileScroll()
        restoredScrollKeyRef.current = fileScrollKey
    }, [loading, fileScrollKey, restoreFileScroll])

    const setMarkdownPreviewMode = (mode: MarkdownPreviewMode) => {
        setMarkdownMode(mode)
        persistMarkdownPreviewMode(mode)
    }

    const fileError = fileContentResult && !fileContentResult.success
        ? (fileContentResult.error ?? 'Failed to read file')
        : !fileContentResult ? fileQuery.error?.message : null
    const missingPath = !filePath
    const fileErrorMessage = fileError ? formatReadFileError(fileError, t) : null
    const fileMetadata = formatFileMetadata(fileContentResult?.size, fileContentResult?.modified, locale)

    return (
        <div className="app-file-page flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        aria-label={t('common.back')}
                        className="app-page-back flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{fileName}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{fileMetadata ?? (filePath || t('file.page.unknownPath'))}</div>
                    </div>
                </div>
            </div>

            <div className="bg-[var(--app-bg)]">
                <div className="app-file-path-toolbar mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                    <FileIcon fileName={fileName} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">{filePath || t('file.page.unknownPath')}</span>
                    <button
                        type="button"
                        onClick={() => copyPath(filePath)}
                        className="app-file-icon-action shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                        title={t('file.page.copyPath')}
                    >
                        {pathCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                    {canDownload ? (
                        <button
                            type="button"
                            onClick={() => downloadBase64File(fileName, fileContentResult!.content!, imageMimeType)}
                            className="app-file-icon-action shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                            title={t('file.page.download')}
                        >
                            <DownloadIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>

            {canShowDiff || (markdownFile && displayMode === 'file') ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="app-file-view-tabs mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                        {canShowDiff ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setDisplayMode('diff')}
                                    className={`app-file-view-tab rounded px-3 py-1 text-xs font-semibold ${displayMode === 'diff' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                                >
                                    {t('file.page.tab.diff')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDisplayMode('file')}
                                    className={`app-file-view-tab rounded px-3 py-1 text-xs font-semibold ${displayMode === 'file' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                                >
                                    {t('file.page.tab.file')}
                                </button>
                            </>
                        ) : null}
                        {markdownFile && displayMode === 'file' ? (
                            <>
                                {diffContent ? <span className="mx-1 h-4 w-px bg-[var(--app-divider)]" aria-hidden="true" /> : null}
                                <button
                                    type="button"
                                    onClick={() => setMarkdownPreviewMode('source')}
                                    className={`app-file-view-tab rounded px-3 py-1 text-xs font-semibold ${showMarkdownSource ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                                >
                                    {t('file.page.tab.source')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMarkdownPreviewMode('preview')}
                                    className={`app-file-view-tab rounded px-3 py-1 text-xs font-semibold ${!showMarkdownSource ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                                >
                                    {t('file.page.tab.preview')}
                                </button>
                            </>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div ref={fileScrollRef} data-hapi-file-scroll="true" className="app-scroll-y flex-1 min-h-0">
                <div className="mx-auto w-full max-w-content p-4">
                    {diffError ? (
                        <details className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs text-[var(--app-hint)]">
                            <summary className="cursor-pointer">{t('file.error.diffUnavailable')}</summary>
                            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{diffError}</pre>
                        </details>
                    ) : null}
                    {missingPath ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.missingPath')}</div>
                    ) : loading ? (
                        <FileContentSkeleton label={t('loading.file')} />
                    ) : displayMode === 'diff' && diffContent ? (
                        <DiffDisplay diffContent={diffContent} />
                    ) : fileErrorMessage ? (
                        <div className="text-sm text-[var(--app-hint)]">{fileErrorMessage}</div>
                    ) : displayMode === 'file' ? (
                        imagePreviewUrl ? (
                            <ImagePreview
                                src={imagePreviewUrl}
                                fileName={fileName}
                                label={t('file.page.imagePreviewAlt', { name: fileName })}
                            />
                        ) : binaryFile ? (
                            <div className="text-sm text-[var(--app-hint)]">
                                {t('file.page.binary')}
                            </div>
                        ) : (
                            decodedContent ? (
                                markdownFile && !showMarkdownSource ? (
                                    <div className="markdown-content">
                                        {canCopyContent ? (
                                            <div className="mb-3 overflow-hidden rounded-md">
                                                <FileContentHeader
                                                    label={t('file.page.tab.preview')}
                                                    copied={contentCopied}
                                                    copyLabel={t('file.page.copyContent')}
                                                    onCopy={() => copyContent(decodedContent)}
                                                />
                                            </div>
                                        ) : null}
                                        <MarkdownRenderer content={decodedContent} standalone />
                                    </div>
                                ) : (
                                    <div
                                        data-hapi-file-source-preview="true"
                                        className="min-w-0 max-w-full overflow-hidden rounded-md bg-[var(--app-code-bg)]"
                                    >
                                        <FileContentHeader
                                            label={language ?? 'text'}
                                            copied={contentCopied}
                                            copyLabel={t('file.page.copyContent')}
                                            onCopy={canCopyContent ? () => copyContent(decodedContent) : undefined}
                                            codeWrap={codeWrap}
                                            wrapEnableLabel={t('code.wrap.enable')}
                                            wrapDisableLabel={t('code.wrap.disable')}
                                            onToggleWrap={() => setCodeWrap(!codeWrap)}
                                        />
                                        <pre
                                            className={`shiki m-0 overflow-y-auto bg-[var(--app-code-bg)] p-3 text-xs font-mono ${codeWrap ? 'overflow-x-hidden' : 'overflow-x-auto'}`}
                                            style={{
                                                whiteSpace: codeWrap ? 'pre-wrap' : 'pre',
                                                ...(codeWrap ? { wordBreak: 'break-word' as const } : {})
                                            }}
                                        >
                                            <code>{highlighted ?? decodedContent}</code>
                                        </pre>
                                    </div>
                                )
                            ) : (
                                <div className="text-sm text-[var(--app-hint)]">{t('file.page.empty')}</div>
                            )
                        )
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.noChanges')}</div>
                    )}
                </div>
            </div>
        </div>
    )
}
