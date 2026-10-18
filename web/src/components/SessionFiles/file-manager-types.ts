import type { FileManagementEntry } from '@hapi/protocol/fileManagement'

export type FileManagerKind = 'file' | 'directory' | 'symlink'

export type FileManagerTarget = {
    /** Always relative to the session's working directory. The root is ''. */
    path: string
    name: string
    kind: FileManagerKind
}

export type FileManagerMutation = {
    sessionId: string
    pathScope: 'relative'
    operation: 'create' | 'rename' | 'move' | 'copy' | 'delete' | 'upload'
    paths: string[]
    /** Exact destination of a single source, never a batch destination directory. */
    destination?: string
    kind?: FileManagerKind
}

export type FileManagerAction = 'create-file' | 'create-directory' | 'rename' | 'move' | 'copy' | 'delete'

export type FileManagerSnapshot = FileManagerTarget & { entry: FileManagementEntry }

export type FileManagerDialogState = {
    id: number
    sessionId: string
    action: FileManagerAction
    parent: string
    sources: FileManagerSnapshot[]
}

export type FileManagerUploadProgress = {
    completed: number
    total: number
    current: string
    cancelled: boolean
}
