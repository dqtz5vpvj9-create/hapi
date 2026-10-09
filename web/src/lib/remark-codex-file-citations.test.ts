import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import { MARKDOWN_PLUGINS } from '@/components/assistant-ui/markdown-text'

function render(source: string) {
    const processor = unified().use(remarkParse).use(MARKDOWN_PLUGINS).use(remarkRehype)
    return toHtml(processor.runSync(processor.parse(source), { value: source }) as never)
}

const path = '/android/paper_repo/mobile-agent-submission-20260911/workreport-20261009/Choreo_revision_workreport_20261009_v19.pptx'
const citation = `:codex-file-citation{path="${path}" purpose="output"}`

describe('Codex file citations through the real Markdown pipeline', () => {
    it('renders the reported output as a named file link alongside normal prose', () => {
        const html = render(`第三页已重画。\n\n${citation}\n\n附：逐页讲稿。`)
        expect(html).toContain(`href="hapi-codex-file:${encodeURIComponent(path)}"`)
        expect(html).toContain('>Choreo_revision_workreport_20261009_v19.pptx</a>')
        expect(html).toContain('第三页已重画。')
        expect(html).toContain('附：逐页讲稿。')
        expect(html).not.toContain('purpose=')
    })

    it.each([
        '/project/中文 文件_含下划线.pptx',
        String.raw`C:\Users\chris\project\中文 文件_含下划线.pptx`,
        '/project/a#b?c%20.md',
    ])('preserves exact filesystem path %s', filePath => {
        const html = render(`:codex-file-citation{purpose='output' path='${filePath}'}`)
        expect(html).toContain(`href="hapi-codex-file:${encodeURIComponent(filePath)}"`)
    })

    it('supports a label and multiple citations in one paragraph', () => {
        const html = render(`已完成 :codex-file-citation[演示稿]{path="slides.pptx"} 和 :codex-file-citation{path="notes.md"}。`)
        expect(html).toContain('>演示稿</a>')
        expect(html).toContain('>notes.md</a>')
    })

    it('leaves inline and fenced code examples literal', () => {
        const html = render('`' + citation + '`\n\n```text\n' + citation + '\n```')
        expect(html).not.toContain('hapi-codex-file:')
        expect(html.match(/:codex-file-citation/g)).toHaveLength(2)
    })

    it('does not activate a partial streaming citation', () => {
        for (let end = 1; end < citation.length; end++) {
            expect(render(citation.slice(0, end))).not.toContain('hapi-codex-file:')
        }
        expect(render(citation)).toContain('hapi-codex-file:')
    })

    it('keeps unknown, escaped and malformed directives readable', () => {
        const unknown = ':codex-annotation{index="1"}'
        const html = render(unknown + '\n\n:codex-file-citation{purpose="output"}\n\n\\' + citation)
        expect(html).toContain(':codex-annotation{index="1"}')
        expect(html).toContain(':codex-file-citation{purpose="output"}')
        expect(html).not.toContain('hapi-codex-file:')
    })

    it('preserves unknown directives after a math source reparse and without a VFile', () => {
        const processor = unified().use(remarkParse).use(MARKDOWN_PLUGINS).use(remarkRehype)
        const source = '\\(a + b\\)\n\n:codex-annotation{index="1"}'
        expect(render(source)).toContain(':codex-annotation{index="1"}')
        expect(toHtml(processor.runSync(processor.parse(source)) as never)).toContain(':codex-annotation{index="1"}')
    })

    it('preserves directives used as an existing link label without nesting links', () => {
        const html = render(`[${citation}](https://example.com)`)
        expect(html).toContain(':codex-file-citation{path=')
        expect(html).not.toContain('hapi-codex-file:')
        expect(html.match(/<a /g)).toHaveLength(1)
    })
})
