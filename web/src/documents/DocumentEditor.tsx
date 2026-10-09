import { useLayoutEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, lineNumbers, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { DocumentSession } from './documentSession'
import { documentName, MAX_EDITABLE_FILE_BYTES } from '@hapi/protocol/documents'

export function DocumentEditor({ session, onSave, findRevision }: { session: DocumentSession; onSave: () => void; findRevision: number }) {
    const root = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const save = useRef(onSave); save.current = onSave
    useLayoutEffect(() => {
        const language = new Compartment()
        const retained = session.editorState?.doc.toString() === session.state.text && session.editorState.facet(EditorState.readOnly) === !session.state.writable ? session.editorState : undefined
        const view = new EditorView({ parent: root.current!, state: retained ?? EditorState.create({
            doc: session.state.text,
            extensions: [lineNumbers(), history(), drawSelection(), search(), EditorView.lineWrapping,
                EditorState.readOnly.of(!session.state.writable), EditorView.editable.of(session.state.writable),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }), language.of([]),
                EditorState.transactionFilter.of(transaction => transaction.newDoc.length > MAX_EDITABLE_FILE_BYTES ? [] : transaction),
                keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { save.current(); return true } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
                EditorView.updateListener.of(update => {
                    session.editorState = update.state
                    if (update.docChanged) session.edit(update.state.doc.toString(), update.state)
                    if (update.selectionSet || update.docChanged) {
                        const range = update.state.selection.main
                        session.patch({ selection: range.empty ? undefined : { kind: 'text', from: range.from, to: range.to,
                            lineStart: update.state.doc.lineAt(range.from).number, lineEnd: update.state.doc.lineAt(range.to).number,
                            quote: update.state.sliceDoc(range.from, Math.min(range.to, range.from + 12000)) } })
                    }
                }),
                EditorView.theme({ '&': { height: '100%', fontSize: '14px', background: 'var(--app-bg)', color: 'var(--app-fg)' },
                    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
                    '.cm-content': { padding: '14px 0' }, '.cm-gutters': { background: 'var(--app-bg)', color: 'var(--app-hint)', border: 'none' },
                    '&.cm-focused': { outline: 'none' }, '.cm-activeLineGutter': { background: 'var(--app-subtle-bg)' },
                }),
            ],
        }) })
        viewRef.current = view
        view.scrollDOM.scrollTop = session.scrollTop
        let disposed = false
        const extension = documentName(session.resource.document).split('.').pop()?.toLowerCase()
        const support = languages.find(item => item.extensions.includes(extension ?? ''))
        if (!retained && support) void support.load().then(value => { if (!disposed) view.dispatch({ effects: language.reconfigure(value) }) })
        return () => {
            disposed = true; session.scrollTop = view.scrollDOM.scrollTop
            if (view.state.doc.toString() === session.state.text) session.editorState = view.state
            viewRef.current = null; view.destroy()
        }
    }, [session])
    useLayoutEffect(() => { if (findRevision && viewRef.current) openSearchPanel(viewRef.current) }, [findRevision])
    return <div className="document-editor" ref={root} data-testid="document-editor" />
}
