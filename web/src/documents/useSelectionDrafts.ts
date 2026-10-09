import { useCallback, useEffect, useState } from 'react'
import type { SelectionReference } from '@hapi/protocol/documents'
import { useOptionalAppContext } from '@/lib/app-context'
import { workspaceStorageKey } from '@/workspace/workspaceStore'
import { updateComposerDraftTextSnapshot } from '@/lib/composer-draft-transfer'
import { acknowledgeSelections, pendingSelections, selectionReferenceText, subscribeSelections } from './selectionDrafts'

/** References stay editable draft cards until the user explicitly submits the existing composer. */
export function useSelectionDrafts(sessionId: string | undefined) {
    const context = useOptionalAppContext()
    const scope = context ? workspaceStorageKey(context.baseUrl, context.token) : undefined
    const [state, setState] = useState<{ key: string; references: SelectionReference[] }>({ key: '', references: [] })
    const key = `${scope}:${sessionId}`
    useEffect(() => {
        if (!scope || !sessionId) return
        const update = () => setState({ key, references: pendingSelections(scope, sessionId) })
        const unsubscribe = subscribeSelections(scope, sessionId, update)
        update()
        return unsubscribe
    }, [scope, sessionId, key])
    const remove = useCallback((ids: string[]) => {
        if (scope && sessionId) {
            acknowledgeSelections(scope, sessionId, ids)
            setState({ key, references: pendingSelections(scope, sessionId) })
        }
    }, [scope, sessionId, key])
    const flush = useCallback((read: () => string, write: (text: string) => void) => {
        if (!scope || !sessionId) return
        const references = pendingSelections(scope, sessionId)
        if (!references.length) return
        const text = [read(), ...references.map(selectionReferenceText)].filter(Boolean).join('\n\n')
        write(text)
        updateComposerDraftTextSnapshot(sessionId, text)
        remove(references.map(reference => reference.id))
    }, [scope, sessionId, remove])
    return { references: state.key === key ? state.references : [], remove, flush }
}
