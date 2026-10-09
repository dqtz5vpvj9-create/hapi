import type { ApiClient } from '@/api/client'
import type { DocumentResource, HtmlViewState } from '@hapi/protocol/documents'
import { artifactMimeFromFilename } from '@hapi/protocol/artifacts'
import { isolatedHtml } from '@/components/Artifacts/documentPreview'
import { base64Bytes } from './documentSession'
import { htmlPreviewBridge } from './htmlPreviewBridge'
const MAX_PREVIEW_RESOURCE_BYTES = 32 * 1024 * 1024

export type HtmlLink = { kind: 'file'; path: string; fragment?: string } | { kind: 'external'; url: string } | { kind: 'anchor'; fragment: string }
/** Resolve against the document's machine path, never the browser's origin. */
export function resolveHtmlLink(href: string, sourcePath?: string): HtmlLink | undefined {
    const value = href.trim()
    if (!value || value.startsWith('#')) return { kind: 'anchor', fragment: value }
    if (/^https?:\/\//i.test(value)) {
        try { return { kind: 'external', url: new URL(value).href } } catch { return undefined }
    }
    if (!sourcePath) return undefined
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(sourcePath)
    let base = windows ? sourcePath.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replaceAll('\\', '/') : sourcePath
    const encoded = base.split('/').map(segment => /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment)).join('/')
    base = windows && base.startsWith('//') ? `file:${encoded}` : windows ? `file:///${encoded}` : `file://${encoded}`
    const raw = /^[a-z]:[\\/]/i.test(value) ? `file:///${value.replaceAll('\\', '/')}` : windows ? value.replaceAll('\\', '/') : value
    try {
        const url = new URL(raw, base)
        if (url.protocol !== 'file:') return undefined
        const pathname = decodeURIComponent(url.pathname)
        let path = windows ? (url.hostname ? `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}` : pathname.replace(/^\/([a-z]:)/i, '$1').replaceAll('/', '\\'))
            : url.hostname ? undefined : pathname
        // Native Windows sessions often use extended-length paths. Keep that
        // spelling so the existing lexical root check sees the same namespace.
        if (path && sourcePath.startsWith('\\\\?\\')) path = path.startsWith('\\\\') ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`
        return path ? { kind: 'file', path, ...(url.hash ? { fragment: url.hash } : {}) } : undefined
    } catch { return undefined }
}

// CSS tokenization skips comments and quoted strings. Rewriting only url() and
// @import keeps declarations, media queries and the report's own styles intact.
export async function rewriteHtmlCss(source: string, asset: (href: string) => Promise<string>, imported: (href: string) => Promise<string>): Promise<string> {
    const pattern = /\/\*[\s\S]*?\*\/|@import\s+(?:url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*([^;]*);|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi
    const parts: (string | Promise<string>)[] = []
    let cursor = 0
    for (const match of source.matchAll(pattern)) {
        parts.push(source.slice(cursor, match.index)); cursor = match.index! + match[0].length
        if (/^@import/i.test(match[0])) {
            const href = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]).trim()
            const media = match[6].trim()
            parts.push(imported(href).then(css => media ? `@media ${media}{${css}}` : css))
        } else if (/^url\(/i.test(match[0])) parts.push(asset((match[7] ?? match[8] ?? match[9]).trim()).then(url => `url(${JSON.stringify(url)})`))
        else parts.push(match[0])
    }
    parts.push(source.slice(cursor))
    return (await Promise.all(parts)).join('')
}

export function parseHtmlSrcset(value: string): { href: string; descriptor: string }[] {
    const candidates: { href: string; descriptor: string }[] = []
    let index = 0
    while (index < value.length) {
        while (/[\s,]/.test(value[index] ?? '') && index < value.length) index++
        const start = index
        while (index < value.length && !/\s/.test(value[index])) index++
        const href = value.slice(start, index)
        if (!href) break
        if (href.endsWith(',')) { candidates.push({ href: href.replace(/,+$/, ''), descriptor: '' }); continue }
        const descriptorStart = index
        let depth = 0
        while (index < value.length) {
            if (value[index] === '(') depth++
            if (value[index] === ')') depth--
            if (value[index] === ',' && depth === 0) break
            index++
        }
        candidates.push({ href, descriptor: value.slice(descriptorStart, index).trim() })
        index++
    }
    return candidates
}
type MediaResource = { id: number; attribute: string; href: string; mime: string; candidates?: { href: string; descriptor: string }[] }
type PreparedHtml = { document: Document; media: MediaResource[] }
export class HtmlPreview {
    readonly id = crypto.randomUUID()
    viewState?: HtmlViewState
    private reads = new Map<string, Promise<string>>()
    private prepared?: Promise<PreparedHtml>
    private cachedBytes = 0
    readonly notices = new Set<string>()
    constructor(readonly source: string, readonly revision: number, private resource: DocumentResource, private api: ApiClient) {}
    get bytes() { return this.cachedBytes }
    private path(href: string, relativeTo?: string) {
        const ref = this.resource.document
        const target = resolveHtmlLink(href, relativeTo ?? (ref.kind === 'file' ? ref.path : undefined))
        if (target?.kind === 'file') return target
        if (!href.startsWith('data:') && !href.startsWith('#')) this.notices.add(href)
        return undefined
    }
    private read(path: string): Promise<string> {
        const key = /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.toLowerCase() : path
        let request = this.reads.get(key)
        if (!request) {
            request = this.api.readSessionFile(this.resource.sessionId, path).then(value => {
                if (!value.success || value.content === undefined) throw new Error(value.error ?? `Unable to read ${path}`)
                if (this.cachedBytes + value.content.length * 2 > MAX_PREVIEW_RESOURCE_BYTES) throw new Error('HTML resource cache exceeds 32 MiB')
                this.cachedBytes += value.content.length * 2
                return value.content
            })
            this.reads.set(key, request)
        }
        return request
    }
    private async asset(href: string, relativeTo?: string, mime?: string): Promise<string> {
        if (href.startsWith('data:') || href.startsWith('#')) return href
        const target = this.path(href, relativeTo)
        if (!target) return 'data:,'
        try {
            const extension = target.path.split('.').at(-1)?.toLowerCase()
            const type = mime ?? ({ css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' } as Record<string, string>)[extension ?? ''] ?? artifactMimeFromFilename(target.path)
            return `data:${type};base64,${await this.read(target.path)}${target.fragment ?? ''}`
        } catch { this.notices.add(target.path); return 'data:,' }
    }
    private async css(source: string, relativeTo?: string, ancestors: string[] = []): Promise<string> {
        return rewriteHtmlCss(source, href => this.asset(href, relativeTo), async href => {
            const target = this.path(href, relativeTo)
            if (!target || ancestors.includes(target.path)) return ''
            try {
                return this.css(new TextDecoder().decode(base64Bytes(await this.read(target.path))), target.path, [...ancestors, target.path])
            } catch { this.notices.add(target.path); return '' }
        })
    }
    async prepare(): Promise<PreparedHtml> {
        return this.prepared ??= (async () => {
            // Prefix CSP before DOMParser sees any untrusted resource markup.
            const document = new DOMParser().parseFromString(isolatedHtml(this.source), 'text/html')
            document.querySelectorAll('meta[http-equiv],base,iframe,object,embed').forEach(element => element.remove())
            document.querySelectorAll('[data-hapi-resource]').forEach(element => element.removeAttribute('data-hapi-resource'))
            const policy = document.createElement('meta')
            policy.httpEquiv = 'Content-Security-Policy'
            policy.content = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
            document.head.prepend(policy)
            if (!document.querySelector('meta[name=viewport]')) {
                const viewport = document.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; document.head.append(viewport)
            }
            const work: Promise<unknown>[] = []
            for (const style of document.querySelectorAll('style')) work.push(this.css(style.textContent ?? '').then(css => { style.textContent = css }))
            for (const element of document.querySelectorAll<HTMLElement>('[style]')) work.push(this.css(element.getAttribute('style')!).then(css => element.setAttribute('style', css)))
            for (const link of document.querySelectorAll<HTMLLinkElement>('link')) {
                if (link.rel.toLowerCase() !== 'stylesheet') { link.remove(); continue }
                const style = document.createElement('style'); style.media = link.media
                link.replaceWith(style)
                work.push((async () => {
                    const target = this.path(link.getAttribute('href') ?? '')
                    if (!target) return
                    try { style.textContent = await this.css(new TextDecoder().decode(base64Bytes(await this.read(target.path))), target.path, [target.path]) }
                    catch { this.notices.add(target.path) }
                })())
            }
            for (const script of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
                const href = script.getAttribute('src')!; script.removeAttribute('src'); script.removeAttribute('integrity')
                work.push(this.asset(href, undefined, 'text/javascript').then(url => script.setAttribute('src', url)))
            }
            const media: MediaResource[] = []
            for (const element of document.querySelectorAll<HTMLElement>('img[src],input[type=image][src],video[src],video[poster],audio[src],source[src]')) {
                const id = media.length
                for (const attribute of ['src', 'poster']) {
                    const href = element.getAttribute(attribute)
                    if (!href || href.startsWith('data:')) continue
                    const mime = attribute === 'poster' || element.tagName === 'IMG' || element.tagName === 'INPUT' ? artifactMimeFromFilename(href.split(/[?#]/)[0]) : element.getAttribute('type') ?? artifactMimeFromFilename(href)
                    element.removeAttribute(attribute)
                    element.dataset.hapiResource = String(id)
                    media.push({ id, attribute, href, mime })
                }
            }
            // Preserve responsive candidate descriptors; every candidate still
            // goes through the initiating machine's authorized read path.
            for (const element of document.querySelectorAll<HTMLImageElement | HTMLSourceElement>('[srcset]')) {
                const candidates = parseHtmlSrcset(element.getAttribute('srcset')!)
                element.removeAttribute('srcset')
                const id = element.dataset.hapiResource === undefined ? media.length : Number(element.dataset.hapiResource)
                element.dataset.hapiResource = String(id)
                media.push({ id, attribute: 'srcset', href: '', mime: '', candidates })
            }
            await Promise.all(work)
            return { document, media }
        })()
    }
    async html(): Promise<string> {
        const { document } = await this.prepare()
        const copy = document.documentElement.cloneNode(true) as HTMLElement
        const script = document.createElement('script')
        script.textContent = htmlPreviewBridge(this.id, this.viewState)
        copy.querySelector('head')!.insertBefore(script, copy.querySelector('head meta')?.nextSibling ?? null)
        return '<!doctype html>' + copy.outerHTML
    }
    async loadMedia(id: number, send: (resource: MediaResource & { url: string }) => void): Promise<void> {
        const { media } = await this.prepare()
        await Promise.all(media.filter(resource => resource.id === id).map(async resource => {
            const url = resource.candidates ? (await Promise.all(resource.candidates.map(async candidate => `${await this.asset(candidate.href)}${candidate.descriptor ? ` ${candidate.descriptor}` : ''}`))).join(', ')
                : await this.asset(resource.href, undefined, resource.mime)
            send({ ...resource, url })
        }))
    }
}
