import { useLayoutEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { registerCodeReadingSource, type CodeReadingSource } from '@/lib/reading-anchor'

function codeReadingSource(view: EditorView, alive: () => boolean): CodeReadingSource {
    return {
        positionAt(node, offset) {
            if (!view.contentDOM.contains(node)) return null
            const position = view.posAtDOM(node, offset)
            const quoteStart = Math.max(0, position - 16)
            return { position, quoteStart, quote: view.state.doc.sliceString(quoteStart, position + 48),
                ...(view.scrollDOM.style.overflowY === 'auto' ? {
                    innerTopOffset: view.coordsAtPos(position)!.top - view.scrollDOM.getBoundingClientRect().top
                } : {}) }
        },
        restore(viewport, anchor, options) {
            const document = view.state.doc
            if (anchor.position > document.length || document.sliceString(anchor.quoteStart, anchor.quoteStart + anchor.quote.length) !== anchor.quote) {
                options.onRestored(false)
                return
            }
            let projected = false
            let innerError = Infinity
            let outerError = Infinity
            const measure = () => view.requestMeasure({
                key: options,
                read: () => {
                    if (!alive() || !options.isCurrent() || view.state.doc !== document) return null
                    const rect = view.coordsAtPos(anchor.position)
                    const inner = view.scrollDOM.style.overflowY === 'auto' && anchor.innerTopOffset !== undefined
                    const top = rect?.top ?? view.documentTop + view.lineBlockAt(anchor.position).top * view.scaleY
                    const innerDelta = inner ? top - view.scrollDOM.getBoundingClientRect().top - anchor.innerTopOffset! : 0
                    return { measured: Boolean(rect), inner, innerDelta,
                        outerDelta: top - viewport.getBoundingClientRect().top - anchor.topOffset }
                },
                write: placement => {
                    if (!alive() || !options.isCurrent()) return
                    if (placement === null || view.state.doc !== document) { options.onRestored(false); return }
                    let scroller: HTMLElement
                    let delta: number
                    if (!placement.measured) {
                        // A single sparse height-map placement mounts the source
                        // line; wrapped character coordinates then take over.
                        if (projected) { options.onRestored(false); return }
                        projected = true
                        scroller = placement.inner ? view.scrollDOM : viewport
                        delta = placement.inner ? placement.innerDelta : placement.outerDelta
                    } else if (placement.inner && Math.abs(placement.innerDelta) > 0.5) {
                        const error = Math.abs(placement.innerDelta)
                        if (error > innerError - 0.5) { options.onRestored(false); return }
                        innerError = error
                        scroller = view.scrollDOM
                        delta = placement.innerDelta
                    } else if (Math.abs(placement.outerDelta) > 0.5) {
                        const error = Math.abs(placement.outerDelta)
                        if (error > outerError - 0.5) { options.onRestored(false); return }
                        outerError = error
                        scroller = viewport
                        delta = placement.outerDelta
                    } else { options.onRestored(true); return }
                    // Viewport recycling can refine a measured character after a
                    // placement. Continue within the same owner only while
                    // residual error shrinks by at least half a CSS pixel.
                    // Clamping/oscillation stops; no scroll target survives
                    // cancellation and no timer restarts this transaction.
                    scroller.scrollTop += delta
                    options.onScroll()
                    measure()
                }
            })
            measure()
        }
    }
}

type Props = {
    code: string
    language?: string
    wrap: boolean
    firstLine?: number
    maxHeight?: number
    clipped?: boolean
    compact?: boolean
}

const codeTheme = EditorView.theme({
    '&': { backgroundColor: 'var(--app-code-bg)', color: 'var(--app-fg)', fontSize: 'inherit' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
    '.cm-content': { padding: '12px 0', caretColor: 'transparent' },
    '.cm-line': { padding: '0 16px' },
    '.cm-gutters': {
        border: 'none', backgroundColor: 'var(--app-code-header-bg)', color: 'var(--app-hint)',
    },
    '.cm-gutterElement': { padding: '0 12px' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--app-selection-bg, #b4d5fe80)' },
})

/** CodeMirror owns line measurement, viewport rendering and selections over
 * unmounted lines. It scrolls with the surrounding chat unless a tool surface
 * already requests a bounded inner viewport. */
export default function LargeCodeView(props: Props) {
    const container = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const wrapping = useRef(new Compartment())
    const numbering = useRef(new Compartment())
    const language = useRef(new Compartment())

    useLayoutEffect(() => {
        const view = new EditorView({
            parent: container.current!,
            state: EditorState.create({
                doc: props.code.replace(/\n$/, ''),
                extensions: [
                    EditorState.readOnly.of(true),
                    EditorView.editable.of(false),
                    EditorView.contentAttributes.of({
                        tabindex: props.clipped ? '-1' : '0',
                        'aria-label': 'Read-only code',
                    }),
                    codeTheme,
                    syntaxHighlighting(defaultHighlightStyle),
                    ...(props.clipped ? [] : [drawSelection(), keymap.of(defaultKeymap)]),
                    wrapping.current.of(props.wrap ? EditorView.lineWrapping : []),
                    numbering.current.of(lineNumbers({ formatNumber: number => String(number + (props.firstLine ?? 1) - 1) })),
                    language.current.of([]),
                ],
            }),
        })
        viewRef.current = view
        const unregister = registerCodeReadingSource(container.current!, codeReadingSource(view, () => viewRef.current === view))
        return () => { unregister(); viewRef.current = null; view.destroy() }
        // Keep the editor and its selection through wrapping and streamed updates.
        // Subsequent prop changes are transactions in the effects below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useLayoutEffect(() => {
        const view = viewRef.current!
        const next = props.code.replace(/\n$/, '')
        const previous = view.state.doc.toString()
        if (previous === next) return
        let from = 0
        while (from < previous.length && from < next.length && previous[from] === next[from]) from++
        let oldEnd = previous.length, newEnd = next.length
        while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
        view.dispatch({ changes: { from, to: oldEnd, insert: next.slice(from, newEnd) } })
    }, [props.code])

    useLayoutEffect(() => {
        viewRef.current!.dispatch({ effects: wrapping.current.reconfigure(props.wrap ? EditorView.lineWrapping : []) })
    }, [props.wrap])

    useLayoutEffect(() => {
        viewRef.current!.dispatch({ effects: numbering.current.reconfigure(lineNumbers({
            formatNumber: number => String(number + (props.firstLine ?? 1) - 1),
        })) })
    }, [props.firstLine])

    useLayoutEffect(() => {
        const view = viewRef.current!
        const name = (props.language ?? '').replace(/^language-/, '').toLowerCase()
        const description = languages.find(candidate => candidate.name.toLowerCase() === name || candidate.alias.includes(name))
        view.dispatch({ effects: language.current.reconfigure([]) })
        if (!description) return
        let cancelled = false
        void description.load().then(support => {
            if (!cancelled) view.dispatch({ effects: language.current.reconfigure(support) })
        })
        return () => { cancelled = true }
    }, [props.language])

    useLayoutEffect(() => {
        const scroller = viewRef.current!.scrollDOM
        scroller.style.maxHeight = props.maxHeight === undefined ? '' : `${props.maxHeight}px`
        scroller.style.overflowY = props.clipped ? 'hidden' : props.maxHeight === undefined ? 'hidden' : 'auto'
        viewRef.current!.requestMeasure()
    }, [props.maxHeight, props.clipped])

    return <div ref={container} data-hapi-large-code="true" className={`min-w-0 max-w-full font-mono ${props.compact ? 'text-xs' : 'text-sm'}`} />
}
