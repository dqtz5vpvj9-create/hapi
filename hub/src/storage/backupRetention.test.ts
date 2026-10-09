import { expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { previewBackupRetention } from './backupRetention'
it('previews old dated backups while retaining the newest count and ignoring unrelated files/symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-retention-'))
    try {
        const names = [1, 2, 3].map(n => `hapi-backup-2026-01-0${n}T10-00-00-000Z.db`)
        names.forEach((name, i) => { writeFileSync(join(dir, name), 'fixture'); utimesSync(join(dir, name), i + 1, i + 1) })
        writeFileSync(join(dir, 'hapi.db'), 'active')
        symlinkSync(join(dir, 'hapi.db'), join(dir, 'hapi-backup-2026-01-04T10-00-00-000Z.db'))
        const result = previewBackupRetention(dir, 1, 30)
        expect(result).toHaveLength(3)
        expect(result[0].action).toBe('keep')
        expect(result.filter(x => x.action === 'review-for-removal')).toHaveLength(2)
        expect(() => previewBackupRetention(dir, 0, 30)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
