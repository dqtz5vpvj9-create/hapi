import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Preview only. Never deletes files, follows symlinks or touches the active database. */
export function previewBackupRetention(directory: string, keep: number, days: number, now = Date.now()) {
    if (!Number.isInteger(keep) || keep < 1 || !Number.isFinite(days) || days < 1) throw new Error('Keep count and age must be positive; keep at least one backup')
    const backups = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^hapi-backup-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/.test(entry.name))
        .map(entry => ({ name: entry.name, bytes: statSync(join(directory, entry.name)).size, modifiedAt: statSync(join(directory, entry.name)).mtimeMs }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
    return backups.map((backup, index) => ({ ...backup, action: index >= keep && now - backup.modifiedAt > days * 86_400_000 ? 'review-for-removal' : 'keep' }))
}
