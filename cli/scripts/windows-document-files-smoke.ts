/** Compile with Bun for Windows; run against a disposable file, never a user document. */
import { dirname } from 'node:path'
import { readDocumentFile, writeDocumentFile } from '../src/modules/common/handlers/documentFiles'

if (process.platform !== 'win32') throw new Error('This acceptance check requires Windows')
const path = process.argv[2]
if (!path) throw new Error('Pass a disposable file path')
const before = await readDocumentFile(path, dirname(path))
if (!before.success || !before.hash) throw new Error('Read failed')
if (process.argv.includes('--expect-denied')) {
    const saved = await writeDocumentFile({ path, expectedHash: before.hash, content: Buffer.from('must not write').toString('base64') }, dirname(path))
    const after = await readDocumentFile(path, dirname(path))
    if (before.writable || saved.success || saved.code !== 'denied' || after.hash !== before.hash) {
        throw new Error('Windows write ACL was not enforced: ' + JSON.stringify({ writable: before.writable, saved, unchanged: after.hash === before.hash }))
    }
    console.log('PASS: Windows write ACL enforced; original unchanged')
} else {
    const saved = await writeDocumentFile({ path, expectedHash: before.hash, content: Buffer.from('HAPI document release saved\r\n').toString('base64') }, dirname(path))
    if (!saved.success) throw new Error('Save failed: ' + saved.error)
    const after = await readDocumentFile(path, dirname(path))
    const conflict = await writeDocumentFile({ path, expectedHash: before.hash, content: Buffer.from('wrong version').toString('base64') }, dirname(path))
    if (!after.success || after.hash !== saved.hash || conflict.success || conflict.code !== 'conflict') throw new Error('Readback/conflict failed')
    console.log('PASS: save, readback, stale revision conflict')
}
