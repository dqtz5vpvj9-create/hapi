import { useRouter } from '@tanstack/react-router'
import { usePane } from '@/workspace/PaneContext'
import { useOptionalAppContext } from '@/lib/app-context'
import { encodeBase64, decodeBase64 } from '@/lib/utils'
import type { DocumentRef } from '@hapi/protocol/documents'
import type { ArtifactRef } from '@hapi/protocol/artifacts'

export function artifactDocumentRef(artifact: ArtifactRef): DocumentRef {
    if (artifact.id.startsWith('session-file:')) {
        const decoded = decodeBase64(artifact.id.slice('session-file:'.length).replaceAll('-', '+').replaceAll('_', '/'))
        if (decoded.ok) return { kind: 'file', path: decoded.text }
    }
    return { kind: 'artifact', artifactId: artifact.id, fileName: artifact.fileName, mimeType: artifact.mimeType }
}
export function useOpenDocument(sessionId: string | undefined) {
    const pane = usePane()
    const context = useOptionalAppContext()
    const router = useRouter({ warn: false })
    if (!sessionId || !context || (!pane && !router)) return undefined
    return (ref: DocumentRef) => {
        const options = { to: '/sessions/$sessionId/file' as const, params: { sessionId }, search: {
            path: ref.kind === 'file' ? encodeBase64(ref.path) : '', document: ref.kind === 'artifact' ? encodeBase64(JSON.stringify(ref)) : undefined, origin: 'chat' as const,
        } }
        return pane ? pane.navigate(options) : router.navigate(options)
    }
}
