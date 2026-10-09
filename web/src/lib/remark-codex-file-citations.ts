import type { Root, RootContent, Link, Parent, PhrasingContent } from 'mdast'
import type { Processor } from 'unified'
import remarkDirective from 'remark-directive'

const PREFIX = 'hapi-codex-file:'

export function decodeCodexFileCitation(href: string): string | null {
    if (!href.startsWith(PREFIX)) return null
    try { return decodeURIComponent(href.slice(PREFIX.length)) } catch { return null }
}

/** Parse Codex's file handoff syntax; opening it still uses the chat path policy. */
export function remarkCodexFileCitations(this: Processor) {
    this.use(remarkDirective)
    // Keep the literal at parse time: other plugins can repair/reparse source,
    // and some Markdown surfaces run the transformer without a VFile value.
    const literals = new WeakMap<RootContent, string>()
    const parser = this.parser!
    this.parser = (source, file) => {
        const tree = parser(source, file) as Root
        const capture = (node: Root | RootContent): void => {
            if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
                literals.set(node, source.slice(node.position!.start.offset, node.position!.end.offset))
            }
            if ('children' in node) node.children.forEach(capture)
        }
        capture(tree)
        return tree
    }
    return (tree: Root) => {
        const visit = (parent: Parent, insideLink = false): void => {
            parent.children = parent.children.map((node): RootContent => {
                if (node.type === 'code' || node.type === 'inlineCode') return node
                if (node.type === 'link' || node.type === 'linkReference') { visit(node, true); return node }
                if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
                    const path = node.attributes?.path
                    let content: PhrasingContent
                    if (!insideLink && node.name === 'codex-file-citation' && node.type !== 'containerDirective' && path?.trim()) {
                        content = {
                            type: 'link', url: PREFIX + encodeURIComponent(path), title: path,
                            children: node.children.length ? node.children : [{ type: 'text', value: path.split(/[\\/]/).at(-1) || path }],
                        } satisfies Link
                    } else {
                        // Other desktop directives and incomplete citations remain readable.
                        // Do not let remark-directive silently discard their name/attributes.
                        content = { type: 'text', value: literals.get(node) ?? '' }
                    }
                    return node.type === 'textDirective' ? content : { type: 'paragraph', children: [content] }
                }
                if ('children' in node) visit(node, insideLink)
                return node
            })
        }
        visit(tree)
    }
}
