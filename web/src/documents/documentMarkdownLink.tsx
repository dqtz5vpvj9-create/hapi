import { createContext, useContext, type ComponentPropsWithoutRef, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { defaultComponents } from '@/components/assistant-ui/markdown-text'
import { isKnownSpaHref } from '@/lib/markdown-href-policy'
import { decodeFilePathHref } from '@/lib/remark-file-path-links'
import { buildSessionReferencePath } from '@/lib/sessionReference'
import { cn, encodeBase64 } from '@/lib/utils'
import { resolveHtmlLink, type HtmlLink } from './htmlPreview'

const LINK_CLASSNAME = 'aui-md-a font-medium text-[var(--app-link)] underline decoration-[color:var(--app-link-muted)] underline-offset-3'

/**
 * Resolve a markdown link against the document it was written in.
 *
 * The standalone renderer (file preview) has no chat/workspace context, so its
 * generic anchor policy renders relative file links inert: there is no session
 * root to resolve them against. Here the current document's own path is the
 * base, which is exactly what a relative link in a README means.
 *
 * App routes, fragments and query-only links are left to the generic anchor so
 * the document viewer never substitutes a file for something that is not one.
 */
export function resolveDocumentMarkdownHref(href: string, sourcePath?: string): HtmlLink | undefined {
    const value = href.trim()
    if (!value) return undefined
    if (value.startsWith('#') || value.startsWith('?')) return undefined
    if (isKnownSpaHref(value)) return undefined
    let resolved: HtmlLink | undefined
    if (value.startsWith('hapi-file:')) {
        // Bare paths are autolinked to a scheme so Windows drive letters survive
        // the markdown pass; decode that payload before resolving it like any path.
        const path = decodeFilePathHref(value)
        resolved = path ? resolveHtmlLink(path, sourcePath) : undefined
    } else {
        resolved = resolveHtmlLink(value, sourcePath)
    }
    // A trailing separator is a directory; the document reader only opens files.
    if (resolved?.kind === 'file' && /[\\/]$/.test(resolved.path)) return undefined
    return resolved
}

type DocumentMarkdownLinkContextValue = {
    sessionId: string
    /** Path of the document being read; relative links resolve below it. */
    sourcePath?: string
    onOpenFile: (path: string) => void
}

const DocumentMarkdownLinkContext = createContext<DocumentMarkdownLinkContextValue | null>(null)

export function DocumentMarkdownLinkProvider(props: { value: DocumentMarkdownLinkContextValue; children: ReactNode }) {
    return <DocumentMarkdownLinkContext.Provider value={props.value}>{props.children}</DocumentMarkdownLinkContext.Provider>
}

const DefaultAnchor = defaultComponents.a as ComponentType<ComponentPropsWithoutRef<'a'>>

/**
 * Anchor used by the document reader. Links that resolve to a workspace file
 * open that file in a pane beside the document, matching report links;
 * everything else keeps the generic markdown anchor policy (external tabs,
 * scheme confirmation, inert fallback).
 */
export function DocumentMarkdownAnchor(props: ComponentPropsWithoutRef<'a'> & ExtraProps) {
    const context = useContext(DocumentMarkdownLinkContext)
    const { node: _node, href, onClick, className, ...anchorProps } = props
    const resolved = context && href ? resolveDocumentMarkdownHref(href, context.sourcePath) : undefined
    if (!context || resolved?.kind !== 'file') {
        return <DefaultAnchor {...anchorProps} href={href} onClick={onClick} className={className} />
    }

    const search = new URLSearchParams({ path: encodeBase64(resolved.path), origin: 'chat' }).toString()
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        context.onOpenFile(resolved.path)
    }

    return (
        <a
            {...anchorProps}
            href={`${buildSessionReferencePath(context.sessionId)}/file?${search}`}
            onClick={handleClick}
            className={cn(LINK_CLASSNAME, className)}
        />
    )
}
