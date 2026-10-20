import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { FileManagementRequest, FileManagementResponse } from '@hapi/protocol/fileManagement'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { filePathSuffix } from '@/documents/filePaths'
import type { FileManagerAction, FileManagerDialogState, FileManagerMutation, FileManagerTarget, FileManagerUploadProgress } from './file-manager-types'
import {
    fileManagerBasename, fileManagerContains, fileManagerDestination, fileManagerJoin,
    fileManagerParent, fileManagerUploadItems, fileManagerUploadParents, topLevelFileManagerPaths, validFileManagerName,
    type FileManagerUploadItem,
} from './file-manager-paths'

export type FileManagementOptions = {
    api: ApiClient | null
    sessionId: string
    caseInsensitive?: boolean
    beforeFileMutation?: (mutation: FileManagerMutation) => boolean | Promise<boolean>
    onFileMutation?: (mutation: FileManagerMutation) => void | Promise<void>
    onFileMutationSettled?: (mutation: FileManagerMutation) => void
    onOpenFile: (path: string) => void
    onRevealDirectory: (path: string) => void
}

function requireSuccess(response: FileManagementResponse, fallback: string): void {
    if (!response.success) throw new Error(response.error || fallback)
}

async function fileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error ?? new Error('Cannot read the selected file.'))
        reader.onabort = () => reject(new DOMException('File read cancelled', 'AbortError'))
        reader.onload = () => {
            if (typeof reader.result !== 'string' || !reader.result.includes(',')) { reject(new Error('Cannot read the selected file.')); return }
            resolve(reader.result.slice(reader.result.indexOf(',') + 1))
        }
        reader.readAsDataURL(file)
    })
}

/**
 * A dialog owns the inspected source revision and the original session. Scope
 * changes invalidate pending UI work; callbacks always identify the actual source
 * session. Mutations are serialized, with document guards held through settlement.
 */
export function useFileManagement(options: FileManagementOptions) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const current = useRef(options)
    current.current = options
    const nextId = useRef(0)
    const dialogScope = useRef<{ id: number; api: ApiClient } | null>(null)
    const busyRef = useRef(false)
    const uploadController = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const [busy, setBusy] = useState(false)
    const [dialog, setDialog] = useState<FileManagerDialogState | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [upload, setUpload] = useState<FileManagerUploadProgress | null>(null)
    const isCurrent = useCallback((scope: FileManagementOptions) => mounted.current
        && scope.api === current.current.api && scope.sessionId === current.current.sessionId, [])

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; uploadController.current?.abort() }
    }, [])
    useEffect(() => {
        setDialog(null)
        setError(null)
        setStatus(null)
        uploadController.current?.abort()
    }, [options.api, options.sessionId])

    const invalidate = useCallback(async (sessionId: string) => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['session-directory', sessionId] }),
            queryClient.invalidateQueries({ queryKey: ['session-files', sessionId] }),
        ])
    }, [queryClient])

    const arm = useCallback(async (action: FileManagerAction, targets: readonly FileManagerTarget[], parent = '') => {
        const scope = current.current
        if (!scope.api || busyRef.current) return
        setError(null)
        setStatus(null)
        if (action === 'create-file' || action === 'create-directory') {
            const id = ++nextId.current
            dialogScope.current = { id, api: scope.api }
            setDialog({ id, sessionId: scope.sessionId, action, parent, sources: [] })
            return
        }
        const paths = topLevelFileManagerPaths(targets.map(target => target.path), scope.caseInsensitive)
        if (!paths.length) return
        busyRef.current = true
        setBusy(true)
        setStatus(t('files.manage.inspecting'))
        try {
            const sources = []
            for (const path of paths) {
                const response = await scope.api.inspectSessionPath(scope.sessionId, path)
                if (!isCurrent(scope)) return
                requireSuccess(response, t('files.manage.failed'))
                if (!response.entry) throw new Error(t('files.manage.failed'))
                sources.push({ path, name: fileManagerBasename(path), kind: response.entry.type, entry: response.entry })
            }
            const id = ++nextId.current
            dialogScope.current = { id, api: scope.api }
            setDialog({ id, sessionId: scope.sessionId, action, parent, sources })
        } catch (cause) {
            if (isCurrent(scope)) setError(cause instanceof Error ? cause.message : t('files.manage.failed'))
        } finally {
            busyRef.current = false
            if (mounted.current) { setBusy(false); setStatus(null) }
        }
    }, [isCurrent, t])

    const submit = useCallback(async (value: string) => {
        const scope = current.current
        const armed = dialog
        if (!scope.api || !armed || armed.sessionId !== scope.sessionId || dialogScope.current?.api !== scope.api || dialogScope.current.id !== armed.id || busyRef.current) return
        const action = armed.action
        const creating = action === 'create-file' || action === 'create-directory'
        let destination: string | undefined
        if (creating || action === 'rename') {
            if (!validFileManagerName(value)) { setError(t('files.manage.invalidName')); return }
            destination = fileManagerJoin(creating ? armed.parent : fileManagerParent(armed.sources[0]!.path), value)
        } else if (action === 'move' || action === 'copy') {
            destination = fileManagerDestination(value)
            if (!destination && !(armed.sources.length > 1 && value.trim() === '.')) {
                setError(t('files.manage.invalidDestination')); return
            }
            destination ??= ''
        }
        const operations: Array<{ request: FileManagementRequest; mutation: FileManagerMutation }> = []
        if (creating) {
            operations.push({
                request: { action, path: destination! },
                mutation: { sessionId: scope.sessionId, pathScope: 'relative', operation: 'create', paths: [destination!], kind: action === 'create-file' ? 'file' : 'directory' },
            })
        } else {
            for (const source of armed.sources) {
                const target = destination === undefined ? undefined
                    : armed.sources.length > 1 ? fileManagerJoin(destination, source.name) : destination
                if (target !== undefined && fileManagerContains(source.path, target, scope.caseInsensitive)) {
                    setError(t('files.manage.destinationInsideSource')); return
                }
                if (target !== undefined && action === 'rename' && armed.sources.length !== 1) {
                    setError(t('files.manage.sameDestination')); return
                }
                const mutation: FileManagerMutation = {
                    sessionId: scope.sessionId, pathScope: 'relative', operation: action as 'rename' | 'move' | 'copy' | 'delete',
                    paths: [source.path], ...(target === undefined ? {} : { destination: target }), kind: source.kind,
                }
                const request: FileManagementRequest = action === 'delete'
                    ? { action, path: source.path, expectedRevision: source.entry.revision, recursive: source.kind === 'directory' }
                    : { action: action as 'rename' | 'move' | 'copy', path: source.path, destination: target!, expectedRevision: source.entry.revision }
                operations.push({ request, mutation })
            }
        }
        busyRef.current = true
        setBusy(true)
        setError(null)
        setStatus(t('files.manage.working'))
        let completed = 0
        try {
            for (const { request, mutation } of operations) {
                if (!isCurrent(scope)) return
                let guarded = false
                try {
                    if (mutation.operation === 'rename' || mutation.operation === 'move' || mutation.operation === 'delete') {
                        if (scope.beforeFileMutation && !await scope.beforeFileMutation(mutation)) {
                            if (isCurrent(scope)) setStatus(t('files.manage.guardDeclined'))
                            return
                        }
                        guarded = true
                        if (!isCurrent(scope)) return
                    }
                    const response = await scope.api.manageSessionFiles(scope.sessionId, request)
                    if (!response.success) {
                        const source = armed.sources.find(candidate => candidate.path === request.path)
                        if (request.action === 'delete' && source && response.deletedPaths?.length) {
                            const paths = response.deletedPaths.flatMap(path => {
                                const suffix = filePathSuffix(path, source.entry.path)
                                return suffix === null ? [] : [source.path + suffix]
                            })
                            for (const path of topLevelFileManagerPaths(paths, scope.caseInsensitive)) {
                                await scope.onFileMutation?.({ sessionId: scope.sessionId, pathScope: 'relative', operation: 'delete', paths: [path] })
                                completed++
                            }
                        } else if ((request.action === 'rename' || request.action === 'move') && response.commit?.action === request.action) {
                            // The no-clobber rename committed even though the subsequent
                            // metadata refresh failed. Retarget once before releasing guards.
                            await scope.onFileMutation?.(mutation)
                            completed++
                        }
                        await invalidate(scope.sessionId)
                    }
                    requireSuccess(response, response.code === 'conflict' ? t('files.manage.conflict') : t('files.manage.failed'))
                    completed++
                    // A successful disk mutation must reconcile its original documents even
                    // when the user switched sessions while the request was in flight.
                    await scope.onFileMutation?.(mutation)
                    await invalidate(scope.sessionId)
                    if (isCurrent(scope)) {
                        if (request.action === 'create-file') scope.onOpenFile(request.path)
                        else if (request.action === 'create-directory') scope.onRevealDirectory(request.path)
                        else if (request.action === 'rename' || request.action === 'move' || request.action === 'copy') scope.onRevealDirectory(fileManagerParent(request.destination))
                    }
                } finally {
                    if (guarded) scope.onFileMutationSettled?.(mutation)
                }
            }
            if (isCurrent(scope)) { setDialog(null); setStatus(null) }
        } catch (cause) {
            if (isCurrent(scope)) {
                const message = cause instanceof Error ? cause.message : t('files.manage.failed')
                setError(completed ? t('files.manage.partialFailure', { count: completed, error: message }) : message)
                // A batch retry requires fresh snapshots and excludes completed sources.
                if (completed) setDialog(null)
            }
        } finally {
            busyRef.current = false
            if (mounted.current) setBusy(false)
            if (isCurrent(scope)) setStatus(null)
        }
    }, [dialog, invalidate, isCurrent, t])

    const uploadItems = useCallback(async (items: readonly FileManagerUploadItem[], parent = '') => {
        const scope = current.current
        if (!scope.api || busyRef.current || items.length === 0) return
        const controller = new AbortController()
        uploadController.current = controller
        busyRef.current = true
        setBusy(true)
        setError(null)
        setStatus(null)
        let completed = 0
        const madeDirectories = new Set<string>([parent])
        try {
            for (const item of items) {
                controller.signal.throwIfAborted()
                if (!isCurrent(scope)) return
                if (item.file.size > 64 * 1024 * 1024) throw new Error(t('files.manage.uploadTooLarge', { name: item.relativePath }))
                const path = fileManagerJoin(parent, item.relativePath)
                setUpload({ completed, total: items.length, current: item.relativePath, cancelled: false })
                for (const relativeDirectory of fileManagerUploadParents(item.relativePath)) {
                    const directory = fileManagerJoin(parent, relativeDirectory)
                    if (madeDirectories.has(directory)) continue
                    controller.signal.throwIfAborted()
                    const created = await scope.api.manageSessionFiles(scope.sessionId, { action: 'create-directory', path: directory })
                    if (!created.success) {
                        // A same-named existing directory is usable; files and symlinks are not.
                        const inspected = await scope.api.inspectSessionPath(scope.sessionId, directory)
                        requireSuccess(inspected, t('files.manage.failed'))
                        if (inspected.entry?.type !== 'directory') throw new Error(created.error ?? t('files.manage.conflict'))
                    } else {
                        await scope.onFileMutation?.({ sessionId: scope.sessionId, pathScope: 'relative', operation: 'create', paths: [directory], kind: 'directory' })
                    }
                    madeDirectories.add(directory)
                }
                controller.signal.throwIfAborted()
                const content = await fileBase64(item.file)
                controller.signal.throwIfAborted()
                // Cancellation stops the remaining queue. Let an already-submitted
                // write settle so its result and document notification stay truthful.
                const result = await scope.api.uploadSessionFile(scope.sessionId, { path, content })
                requireSuccess(result, t('files.manage.failed'))
                completed++
                await scope.onFileMutation?.({ sessionId: scope.sessionId, pathScope: 'relative', operation: 'upload', paths: [path], kind: 'file' })
            }
            if (isCurrent(scope)) setStatus(t(controller.signal.aborted ? 'files.manage.uploadCancelled' : 'files.manage.uploadDone', { count: completed }))
        } catch (cause) {
            if (isCurrent(scope)) {
                if (controller.signal.aborted) setStatus(t('files.manage.uploadCancelled', { count: completed }))
                else {
                    const message = cause instanceof Error ? cause.message : t('files.manage.failed')
                    setError(completed ? t('files.manage.partialFailure', { count: completed, error: message }) : message)
                }
            }
        } finally {
            await invalidate(scope.sessionId)
            if (isCurrent(scope)) scope.onRevealDirectory(parent)
            uploadController.current = null
            busyRef.current = false
            if (mounted.current) { setBusy(false); setUpload(null) }
        }
    }, [invalidate, isCurrent, t])

    const uploadFiles = useCallback(async (files: readonly File[], parent = '') => {
        try { await uploadItems(fileManagerUploadItems(files), parent) }
        catch (cause) { setError(cause instanceof Error ? cause.message : t('files.manage.failed')) }
    }, [t, uploadItems])

    const download = useCallback(async (target: FileManagerTarget) => {
        const scope = current.current
        if (!scope.api || target.kind !== 'file') return
        setError(null)
        try {
            const blob = await scope.api.downloadSessionFile(scope.sessionId, target.path)
            if (!isCurrent(scope)) return
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url; link.download = target.name
            document.body.appendChild(link)
            link.click(); link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (cause) {
            if (isCurrent(scope)) setError(cause instanceof Error ? cause.message : t('files.manage.failed'))
        }
    }, [isCurrent, t])

    return {
        busy, dialog, error, status, upload, arm, submit, uploadFiles, uploadItems, download,
        clearError: () => setError(null),
        closeDialog: () => { if (!busyRef.current) { setDialog(null); setError(null) } },
        cancelUpload: () => { uploadController.current?.abort(); setUpload(previous => previous ? { ...previous, cancelled: true } : null) },
    }
}
