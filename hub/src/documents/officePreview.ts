import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const cache = new Map<string, Buffer>()
const rangePreviews = new Map<string, { key: string; namespace: string; sessionId: string }>()
const pending = new Map<string, Promise<Buffer>>()
let serial: Promise<unknown> = Promise.resolve()
const MAX_CACHE = 96 * 1024 * 1024

/** Static derivatives only. Authentication and source revision checks happen before cache access. */
export function officePreview(key: string, bytes: Buffer, extension: string): Promise<Buffer> {
    if (!/^(pptx?|docx?|od[tp])$/.test(extension)) return Promise.reject(new Error('Unsupported Office preview format'))
    const cached = cache.get(key)
    if (cached) { cache.delete(key); cache.set(key, cached); return Promise.resolve(cached) }
    const running = pending.get(key)
    if (running) return running
    if (pending.size >= 4) return Promise.reject(new Error('Document preview is busy. Retry shortly.'))
    const task = serial.catch(() => {}).then(async () => {
        const parent = process.env.HAPI_DOCUMENT_TEMP_DIR ?? tmpdir()
        await mkdir(parent, { recursive: true })
        const directory = await mkdtemp(join(parent, 'hapi-office-'))
        try {
            const profile = join(directory, 'profile')
            await mkdir(join(profile, 'user'), { recursive: true })
            // No document macros or external link updates during unattended conversion.
            await writeFile(join(profile, 'user', 'registrymodifications.xcu'), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinks" oor:op="fuse"><value>0</value></prop></item></oor:items>`)
            const source = join(directory, `source.${extension}`)
            await writeFile(source, bytes, { mode: 0o600 })
            await execute(process.env.HAPI_OFFICE_BINARY ?? 'soffice', [
                `-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nodefault',
                '--convert-to', 'pdf', '--outdir', directory, source,
            ], { timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true })
            const output = join(directory, 'source.pdf')
            if ((await stat(output)).size > MAX_CACHE) throw new Error('Document preview exceeds the 96 MiB limit')
            const result = await readFile(output)
            cache.set(key, result)
            let total = [...cache.values()].reduce((sum, value) => sum + value.length, 0)
            for (const [oldKey, value] of cache) {
                if (total <= MAX_CACHE && cache.size <= 12) break
                cache.delete(oldKey); total -= value.length
                for (const [id, preview] of rangePreviews) if (preview.key === oldKey) rangePreviews.delete(id)
            }
            return result
        } finally { await rm(directory, { recursive: true, force: true }) }
    }).finally(() => { pending.delete(key) })
    pending.set(key, task); serial = task
    return task
}

/** Range handles share the bounded conversion cache; they never grant access by themselves. */
export function registerOfficePreview(key: string, namespace: string, sessionId: string): string {
    for (const [id, preview] of rangePreviews) {
        if (preview.key === key && preview.namespace === namespace && preview.sessionId === sessionId) return id
    }
    const id = crypto.randomUUID()
    rangePreviews.set(id, { key, namespace, sessionId })
    return id
}

export function readOfficePreview(id: string, namespace: string, sessionId: string): Buffer | undefined {
    const preview = rangePreviews.get(id)
    if (!preview || preview.namespace !== namespace || preview.sessionId !== sessionId) return
    const bytes = cache.get(preview.key)
    if (bytes) { cache.delete(preview.key); cache.set(preview.key, bytes) }
    return bytes
}
