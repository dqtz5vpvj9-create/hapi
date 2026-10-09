import { documentName, type SelectionReference } from '@hapi/protocol/documents'
import { useDocumentLabels } from './labels'

export function DocumentReferenceDrafts({ references, onRemove }: { references: SelectionReference[]; onRemove: (ids: string[]) => void }) {
    const labels = useDocumentLabels()
    if (!references.length) return null
    return <div className="flex flex-wrap gap-2 px-3 pt-2" data-testid="document-reference-drafts">
        {references.map(reference => {
            const selection = reference.selection
            const location = selection.kind === 'page' ? `${labels.pages} ${selection.page}`
                : selection.kind === 'cells' ? `${selection.sheet}!${selection.range}` : selection.kind === 'html' ? labels.preview : `L${selection.lineStart}–${selection.lineEnd}`
            return <div key={reference.id} className="flex max-w-full items-start gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs">
                <details className="min-w-0"><summary className="cursor-pointer truncate">{documentName(reference.resource.document)} · {location}</summary>
                    <pre className="max-h-36 max-w-full overflow-auto whitespace-pre-wrap py-2">{selection.quote || labels.region}</pre>
                    <p className="break-all text-[var(--app-hint)]">{reference.resource.document.kind === 'file' ? reference.resource.document.path : reference.resource.document.fileName}</p>
                </details>
                <button type="button" aria-label={`${labels.removeReference} ${documentName(reference.resource.document)}`} onClick={() => onRemove([reference.id])}>×</button>
            </div>
        })}
    </div>
}
