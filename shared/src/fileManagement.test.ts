import { describe, expect, it } from 'bun:test'
import { FileManagementRequestSchema, FileManagementUploadRequestSchema } from './fileManagement'

describe('file management wire contract', () => {
    it('requires a revision for each source mutation without accepting overwrite or shell parameters', () => {
        for (const action of ['rename', 'move', 'copy']) {
            const request = { action, path: 'source', destination: 'destination', expectedRevision: '0'.repeat(64) }
            expect(FileManagementRequestSchema.safeParse(request).success).toBe(true)
            expect(FileManagementRequestSchema.safeParse({ ...request, expectedRevision: null }).success).toBe(false)
            expect(FileManagementRequestSchema.safeParse({ ...request, overwrite: true }).success).toBe(false)
        }
        expect(FileManagementRequestSchema.safeParse({ action: 'delete', path: 'folder', expectedRevision: '0'.repeat(64), recursive: true }).success).toBe(true)
        expect(FileManagementRequestSchema.safeParse({ action: 'execute', path: '.', command: 'ls' }).success).toBe(false)
    })
    it('requires a destination and permits only an exclusive upload', () => {
        expect(FileManagementUploadRequestSchema.safeParse({ path: 'nested/file.bin', content: '' }).success).toBe(true)
        expect(FileManagementUploadRequestSchema.safeParse({ path: '', content: '' }).success).toBe(false)
        expect(FileManagementUploadRequestSchema.safeParse({ path: 'bad\0name', content: '' }).success).toBe(false)
        expect(FileManagementUploadRequestSchema.safeParse({ path: 'file.bin', content: '', overwrite: true }).success).toBe(false)
    })
})
