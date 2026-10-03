import { artifactMimeFromFilename, type ArtifactRef } from '@hapi/protocol/artifacts'

export const fileArtifactMime = artifactMimeFromFilename

export function fileArtifactRef(path: string): ArtifactRef {
    const bytes = new TextEncoder().encode(path)
    const encoded = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    return { id: `session-file:${encoded}`, fileName: path.split(/[\\/]/).at(-1) ?? path, mimeType: fileArtifactMime(path) }
}
