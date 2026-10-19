import { useLayoutEffect, useRef } from 'react'
import { EditorState, Compartment, Transaction, type ChangeSet, type Text } from '@codemirror/state'
import { EditorView, lineNumbers, keymap, drawSelection, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { DocumentSession } from './documentSession'
import { documentName, MAX_EDITABLE_FILE_BYTES } from '@hapi/protocol/documents'

type EditorBinding = {
    session: DocumentSession
    onSave: () => void
    text: string
    synchronizing: boolean
    retainedState?: EditorState
}

// EditorState (including its extensions and undo history) survives React mounts.
// Its callbacks must resolve the live view, not capture the first pane's session
// or save route. Compartments likewise need to remain addressable after reuse.
const bindings = new WeakMap<EditorView, EditorBinding>()
const publishedEdits = new WeakMap<DocumentSession, { previous: Text; text: string; changes: ChangeSet }>()
const language = new Compartment()
const writable = new Compartment()
const writableExtensions = (value: boolean) => [EditorState.readOnly.of(!value), EditorView.editable.of(value)]

function saveDocument(view: EditorView): boolean {
    const binding = bindings.get(view)
    if (!binding) return false
    binding.onSave()
    return true
}

function publishEditorUpdate(update: ViewUpdate) {
    const binding = bindings.get(update.view)
    if (!binding || binding.synchronizing || (!update.docChanged && !update.selectionSet)) return
    const { session } = binding
    binding.retainedState = update.state
    session.editorState = update.state
    if (update.docChanged) {
        binding.text = update.state.doc.toString()
        const edit = { previous: update.startState.doc, text: binding.text, changes: update.changes }
        publishedEdits.set(session, edit)
        try { session.edit(binding.text, update.state) }
        finally { if (publishedEdits.get(session) === edit) publishedEdits.delete(session) }
    }
    const range = update.state.selection.main
    session.patch({ selection: range.empty ? undefined : { kind: 'text', from: range.from, to: range.to,
        lineStart: update.state.doc.lineAt(range.from).number, lineEnd: update.state.doc.lineAt(range.to).number,
        quote: update.state.sliceDoc(range.from, Math.min(range.to, range.from + 12000)) } })
}

function synchronizeEditor(view: EditorView, binding: EditorBinding) {
    const next = binding.session.state
    const textChanged = binding.text !== next.text
    const writableChanged = view.state.facet(EditorState.readOnly) !== !next.writable || view.state.facet(EditorView.editable) !== next.writable
    if (!textChanged && !writableChanged) return

    let changes: ChangeSet | { from: number; to: number; insert: string } | undefined
    const published = publishedEdits.get(binding.session)
    if (textChanged && published && published.text === next.text && view.state.doc.eq(published.previous)) {
        // Keep exact edit boundaries when a sibling is publishing synchronously.
        // Reconstructing them from repeated text can otherwise move a space from
        // one pane's undo history into the other pane's edit.
        changes = published.changes
    } else if (textChanged) {
        const previous = binding.text
        let from = 0, to = previous.length, nextTo = next.text.length
        while (from < to && from < nextTo && previous[from] === next.text[from]) from++
        while (to > from && nextTo > from && previous[to - 1] === next.text[nextTo - 1]) { to--; nextTo-- }
        changes = { from, to, insert: next.text.slice(from, nextTo) }
    }

    binding.synchronizing = true
    binding.text = next.text
    try {
        // Mapping a minimal change preserves this pane's selection, viewport and
        // undo history. Another pane's edit must not become our next Undo step or
        // publish our mapped selection over the initiating pane's selection.
        view.dispatch({ changes, effects: writableChanged ? writable.reconfigure(writableExtensions(next.writable)) : undefined,
            annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] })
    } finally {
        binding.text = view.state.doc.toString()
        binding.synchronizing = false
    }
}

export function DocumentEditor({ session, onSave, findRevision }: { session: DocumentSession; onSave: () => void; findRevision: number }) {
    const root = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    useLayoutEffect(() => {
        const retained = session.editorState?.doc.toString() === session.state.text ? session.editorState : undefined
        const view = new EditorView({ parent: root.current!, state: retained ?? EditorState.create({
            doc: session.state.text,
            extensions: [lineNumbers(), history(), drawSelection(), search(), EditorView.lineWrapping,
                writable.of(writableExtensions(session.state.writable)),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }), language.of([]),
                EditorState.transactionFilter.of(transaction => transaction.docChanged && transaction.newDoc.length > MAX_EDITABLE_FILE_BYTES && !transaction.annotation(Transaction.remote) ? [] : transaction),
                keymap.of([{ key: 'Mod-s', preventDefault: true, run: saveDocument }, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
                EditorView.updateListener.of(publishEditorUpdate),
                EditorView.theme({ '&': { height: '100%', fontSize: '14px', background: 'var(--app-bg)', color: 'var(--app-fg)' },
                    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
                    '.cm-content': { padding: '14px 0' }, '.cm-gutters': { background: 'var(--app-bg)', color: 'var(--app-hint)', border: 'none' },
                    '&.cm-focused': { outline: 'none' }, '.cm-activeLineGutter': { background: 'var(--app-subtle-bg)' },
                }),
            ],
        }) })
        viewRef.current = view
        const binding: EditorBinding = { session, onSave, text: view.state.doc.toString(), synchronizing: false, retainedState: retained }
        bindings.set(view, binding)
        view.scrollDOM.scrollTop = session.scrollTop
        const unsubscribe = session.subscribe(() => synchronizeEditor(view, binding))
        synchronizeEditor(view, binding)
        let disposed = false
        const extension = documentName(session.resource.document).split('.').pop()?.toLowerCase()
        const support = languages.find(item => item.extensions.includes(extension ?? ''))
        // A previous mount may have ended before its language finished loading.
        if (support) void support.load().then(value => { if (!disposed) view.dispatch({ effects: language.reconfigure(value) }) })
        return () => {
            disposed = true; unsubscribe(); bindings.delete(view)
            // Closing an idle sibling must not replace the active pane's retained
            // selection and undo history with that sibling's independent state.
            if (view.state.doc.toString() === session.state.text && (!session.editorState || session.editorState === binding.retainedState)) {
                session.editorState = view.state
                session.scrollTop = view.scrollDOM.scrollTop
            }
            viewRef.current = null; view.destroy()
        }
    }, [session])
    useLayoutEffect(() => {
        const binding = viewRef.current && bindings.get(viewRef.current)
        if (binding) binding.onSave = onSave
    }, [session, onSave])
    useLayoutEffect(() => { if (findRevision && viewRef.current) openSearchPanel(viewRef.current) }, [findRevision])
    return <div className="document-editor" ref={root} data-testid="document-editor" />
}
