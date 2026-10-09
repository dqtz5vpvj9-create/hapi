import { useState, useSyncExternalStore } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppContext } from '@/lib/app-context'
import type { WorkspaceStore } from '@/workspace/workspaceStore'
import { documentName } from '@hapi/protocol/documents'
import { useDocumentLabels } from './labels'
import type { DocumentSession } from './documentSession'

export function DocumentLeaveDialog({ store }: { store: WorkspaceStore }) {
    useSyncExternalStore(store.subscribe, store.get)
    return <DocumentLeavePrompt request={store.leaveRequest} />
}
export function DocumentLeavePrompt({ request }: { request?: { sessions: DocumentSession[]; finish: (leave: boolean) => void } }) {
    const { api } = useAppContext()
    const labels = useDocumentLabels()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string>()
    const decide = async (action: 'save' | 'keep' | 'discard') => {
        if (!request) return
        setBusy(true); setError(undefined)
        try {
            for (const session of request.sessions) {
                if (action === 'save') {
                    await session.load(api)
                    if (session.state.phase !== 'ready' || !await session.save(api) || session.state.dirty) throw new Error(session.state.error ?? 'Document changed during save. Save again to keep the latest edits.')
                } else if (action === 'discard') await session.discard()
                else if (session.state.dirty) await session.persist()
            }
            request.finish(true)
        } catch (reason) { setError(String(reason)) }
        finally { setBusy(false) }
    }
    return <Dialog open={!!request} onOpenChange={open => { if (!open && !busy) request?.finish(false) }}>
        <DialogContent aria-describedby="document-leave-description">
            <DialogHeader><DialogTitle>{labels.closeTitle}</DialogTitle></DialogHeader>
            <p id="document-leave-description">{labels.closeDescription}</p>
            <p>{request?.sessions.map(session => documentName(session.resource.document)).join(', ')}</p>
            {error ? <p role="alert">{error}</p> : null}
            <div className="flex flex-wrap justify-end gap-3">
                <button disabled={busy} onClick={() => request?.finish(false)}>{labels.cancel}</button>
                <button disabled={busy} onClick={() => void decide('discard')}>{labels.discard}</button>
                <button disabled={busy} onClick={() => void decide('keep')}>{labels.keepDraft}</button>
                <button disabled={busy} onClick={() => void decide('save')}>{labels.save}</button>
            </div>
        </DialogContent>
    </Dialog>
}
