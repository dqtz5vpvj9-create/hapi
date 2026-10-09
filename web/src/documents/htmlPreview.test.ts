import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { HtmlPreview, parseHtmlSrcset, resolveHtmlLink, rewriteHtmlCss } from './htmlPreview'
import { bytesBase64, DocumentRegistry } from './documentSession'
import { selectionReferenceText } from './selectionDrafts'

describe('HTML document routing and isolation', () => {
    it('resolves Windows file URLs, UNC paths, relative CSS assets and encoded names on the source machine', () => {
        const source = '\\\\?\\C:\\Users\\fixture\\阅读 台账\\index.html'
        expect(resolveHtmlLink('file:///C:/Users/fixture/packets/%E5%8E%9F%E6%96%87%201.txt', source)).toEqual({ kind: 'file', path: '\\\\?\\C:\\Users\\fixture\\packets\\原文 1.txt' })
        expect(resolveHtmlLink('../images/icon.svg#check', source)).toEqual({ kind: 'file', path: '\\\\?\\C:\\Users\\fixture\\images\\icon.svg', fragment: '#check' })
        expect(resolveHtmlLink('file://server/share/a.txt', source)).toEqual({ kind: 'file', path: '\\\\?\\UNC\\server\\share\\a.txt' })
        expect(resolveHtmlLink('next.txt', '\\\\server\\share\\folder\\index.html')).toEqual({ kind: 'file', path: '\\\\server\\share\\folder\\next.txt' })
        expect(resolveHtmlLink('data:text/html,x', source)).toBeUndefined()
        expect(resolveHtmlLink('javascript:alert(1)', source)).toBeUndefined()
        expect(resolveHtmlLink('file:///C:/other.txt')).toBeUndefined()
    })
    it('preserves POSIX filename characters and document-relative fragments', () => {
        expect(resolveHtmlLink('icon.svg', '/project/report #1/index.html')).toEqual({ kind: 'file', path: '/project/report #1/icon.svg' })
        expect(resolveHtmlLink('C:%5Cnotes.txt', '/project/index.html')).toBeUndefined()
        expect(resolveHtmlLink('a%5Cb.txt', '/project/index.html')).toEqual({ kind: 'file', path: '/project/a\\b.txt' })
        expect(resolveHtmlLink('#section', '/project/index.html')).toEqual({ kind: 'anchor', fragment: '#section' })
        expect(resolveHtmlLink('https://[broken', '/project/index.html')).toBeUndefined()
    })
    it('keeps responsive srcset descriptors and commas inside data URLs', () => {
        expect(parseHtmlSrcset('icon.svg 1x, icon-large.svg 2x')).toEqual([{ href: 'icon.svg', descriptor: '1x' }, { href: 'icon-large.svg', descriptor: '2x' }])
        expect(parseHtmlSrcset('data:image/png;base64,abc 1x, large.png 2x')).toEqual([{ href: 'data:image/png;base64,abc', descriptor: '1x' }, { href: 'large.png', descriptor: '2x' }])
    })
    it('rewrites nested CSS resources without changing comments or quoted content', async () => {
        const asset = vi.fn(async value => `data:image/svg+xml,${value}`)
        const imported = vi.fn(async value => `/* ${value} */ .shared{color:red}`)
        const result = await rewriteHtmlCss('/* url(secret.png) */ @import "base.css" screen; .x{background:URL("a)b.svg");content:"url(fake.png)"}', asset, imported)
        expect(result).toBe('/* url(secret.png) */ @media screen{/* base.css */ .shared{color:red}} .x{background:url("data:image/svg+xml,a)b.svg");content:"url(fake.png)"}')
        expect(asset).toHaveBeenCalledExactlyOnceWith('a)b.svg')
        expect(imported).toHaveBeenCalledExactlyOnceWith('base.css')
    })
    it('routes all local reads through the initiating session, deduplicates CSS imports and reports unavailable resources', async () => {
        const files: Record<string, string> = { '/project/styles/main.css': '@import "nested/base.css"; .x{background:url(../icon.svg)}',
            '/project/styles/nested/base.css': '@import "../main.css"; body{color:rgb(1,2,3)}', '/project/icon.svg': '<svg/>', '/project/filter.js': 'document.body.dataset.script="yes"' }
        const read = vi.fn(async (_session: string, path: string) => files[path] === undefined ? { success: false, error: 'denied' } : { success: true, content: bytesBase64(new TextEncoder().encode(files[path])) })
        const preview = new HtmlPreview('<!doctype html><html lang="zh"><head><title>Report</title><link rel="stylesheet" href="styles/main.css"><script defer src="filter.js"></script></head><body><img src="data:image/png;base64,abc"><img width="20" src="icon.svg"><img src="missing.png"><picture><source srcset="icon.svg 1x, icon.svg 2x"><img src="data:image/png;base64,abc"></picture><iframe src="https://example.com"></iframe><a href="https://example.com">External</a></body></html>', 1,
            { kind: 'document', sessionId: 'windows-session', document: { kind: 'file', path: '/project/index.html' } }, { readSessionFile: read } as unknown as ApiClient)
        const html = await preview.html()
        expect(html).toContain('lang="zh"')
        expect(html).toContain('connect-src \'none\'')
        expect(html).not.toContain('<iframe')
        expect(html).not.toContain('src="icon.svg"')
        expect((await preview.prepare()).document.querySelector('img')?.hasAttribute('data-hapi-resource')).toBe(false)
        expect(html).toContain('data:text/javascript;base64,')
        expect(html).toContain('color:rgb(1,2,3)')
        expect(read.mock.calls.filter(([, path]) => path === '/project/styles/main.css')).toHaveLength(1)
        expect(read.mock.calls.every(([id]) => id === 'windows-session')).toBe(true)
        const sent = vi.fn()
        await preview.loadMedia(0, sent)
        await preview.loadMedia(0, sent)
        expect(read.mock.calls.filter(([, path]) => path === '/project/icon.svg')).toHaveLength(1)
        expect(sent.mock.calls[0][0].url).toMatch(/^data:image\/svg\+xml;base64,/)
        await preview.loadMedia(1, sent)
        expect([...preview.notices]).toContain('/project/missing.png')
        await preview.loadMedia(2, sent)
        expect(sent.mock.calls.at(-1)![0].attribute).toBe('srcset')
        expect(sent.mock.calls.at(-1)![0].url).toMatch(/ 1x, data:image\/svg\+xml;base64,.* 2x$/)
        await preview.loadMedia(999, sent)
        expect(read.mock.calls.some(([, path]) => path === 'https://example.com')).toBe(false)
    })
    it('defaults HTML to preview and distinguishes rendered selections from source offsets', () => {
        const resource = { kind: 'document' as const, sessionId: 'A', document: { kind: 'file' as const, path: '/project/index.htm' } }
        expect(new DocumentRegistry(crypto.randomUUID()).get(resource).state.mode).toBe('preview')
        const result = selectionReferenceText({ id: 'selection', resource, version: 'existing-revision', targetSessionId: 'A',
            selection: { kind: 'html', quote: '选中的正文', start: { path: [1, 0], offset: 0 }, end: { path: [1, 0], offset: 5 } } })
        expect(result).toContain('rendered HTML; DOM range')
        expect(result).toContain('Revision: existing-revision')
        expect(result).toContain('> 选中的正文')
        expect(result).not.toContain('lines ')
    })
})
