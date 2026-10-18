import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { ArtifactCard } from '@/components/Artifacts/ArtifactCard'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function QueuedAttachmentButton({ attachment, api, sessionId }: {
    attachment: AttachmentMetadata
    api: ApiClient | null
    sessionId: string
}) {
    const [open, setOpen] = useState(false)
    return <>
        <button type="button" onClick={() => setOpen(true)}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-link)] hover:underline"
            title={attachment.filename}>
            <span aria-hidden="true">📎</span>
            <span className="truncate">{attachment.filename}</span>
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[90dvh] overflow-auto">
                <DialogHeader><DialogTitle>{attachment.filename}</DialogTitle></DialogHeader>
                <ArtifactCard
                    artifact={attachment.artifact ? { ...attachment.artifact, fileName: attachment.filename } : { id: attachment.id, fileName: attachment.filename, mimeType: attachment.mimeType, size: attachment.size }}
                    previewUrl={attachment.previewUrl}
                    dataSource={api ? { api, sessionId } : undefined}
                />
            </DialogContent>
        </Dialog>
    </>
}
