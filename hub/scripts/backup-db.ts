import { previewBackupRetention } from '../src/storage/backupRetention'
import { createSqliteBackup, verifySqliteBackup } from '../src/storage/sqliteBackup'

const [command, source, destination] = process.argv.slice(2)
try {
    if (command === 'prune-preview' && source) {
        const [keep = '7', days = '30'] = process.argv.slice(4)
        console.log(JSON.stringify({ dryRun: true, files: previewBackupRetention(source, Number(keep), Number(days)) }, null, 2))
    } else if (command === 'verify' && source && !destination) {
        console.log(JSON.stringify({ verified: true, ...verifySqliteBackup(source) }))
    } else if ((command === 'backup' || command === 'restore-copy') && source && destination) {
        console.log(JSON.stringify({ verified: true, destination, ...createSqliteBackup(source, destination) }))
        if (command === 'restore-copy') console.log('Restore copy verified. Stop the Hub before switching DB_PATH to this file. Keep the original database and sidecars together.')
    } else {
        console.error('Usage: bun hub/scripts/backup-db.ts backup|restore-copy SOURCE NEW_DESTINATION\n       bun hub/scripts/backup-db.ts verify BACKUP\n       bun hub/scripts/backup-db.ts prune-preview DIRECTORY [KEEP_COUNT=7] [MIN_AGE_DAYS=30]')
        process.exitCode = 1
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Backup operation failed')
    process.exitCode = 1
}
