import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { StorageUsagePie } from '@/components/settings/StorageUsagePie'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { formatFileSize } from '@/lib/file-metadata'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export default function SettingsStoragePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [backingUp, setBackingUp] = useState(false)
    const [backupError, setBackupError] = useState(false)
    const backupLock = useRef(false)
    async function downloadBackup() {
        if (!api || backupLock.current) return
        backupLock.current = true
        setBackingUp(true)
        setBackupError(false)
        try {
            const blob = await api.downloadSqliteBackup()
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `hapi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
        } catch { setBackupError(true) }
        finally { backupLock.current = false; setBackingUp(false) }
    }
    const query = useQuery({
        queryKey: queryKeys.sqliteStorage,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSqliteStorageUsage()
        },
        enabled: Boolean(api),
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    })

    return (
        <SettingsPageContent description={t('settings.storage.description')}>
            {query.isLoading || query.error ? (
                <SettingsSection>
                    {query.isLoading ? <SettingsRow label={t('settings.storage.loading')} /> : null}
                    {query.error ? (
                        <SettingsRow
                            label={t('settings.storage.error')}
                            description={query.error instanceof Error ? query.error.message : undefined}
                        />
                    ) : null}
                </SettingsSection>
            ) : null}
            {query.data ? (
                <StorageUsagePie
                    usage={{
                        databaseBytes: query.data.databaseBytes,
                        walBytes: query.data.walBytes,
                        shmBytes: query.data.shmBytes,
                    }}
                    totalBytes={query.data.totalBytes}
                    path={query.data.path}
                    labels={{
                        title: t('settings.storage.chartTitle'),
                        empty: t('settings.storage.chartEmpty'),
                        database: t('settings.storage.database'),
                        wal: t('settings.storage.wal'),
                        shm: t('settings.storage.shm'),
                        total: t('settings.storage.total'),
                        path: t('settings.storage.path'),
                    }}
                />
            ) : null}
            {query.data ? <SettingsSection title={t('settings.storage.backupTitle')}>
                <div className="space-y-2 p-3 text-sm">
                    <p>{t('settings.storage.backupHint')}</p>
                    <button type="button" onClick={() => void downloadBackup()} disabled={backingUp} className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-[var(--app-button-text)] disabled:opacity-50">
                        {backingUp ? t('settings.storage.backingUp') : t('settings.storage.downloadBackup')}
                    </button>
                    {backupError ? <p role="alert">{t('settings.storage.backupError')}</p> : null}
                    <details><summary className="cursor-pointer">{t('settings.storage.restoreTitle')}</summary>
                        <p className="mt-2">{t('settings.storage.restoreHint')}</p>
                        <pre className="mt-2 overflow-x-auto text-xs">{'bun hub/scripts/backup-db.ts verify BACKUP.db\nbun hub/scripts/backup-db.ts restore-copy BACKUP.db NEW.db\nbun hub/scripts/backup-db.ts prune-preview BACKUP_DIRECTORY 7 30'}</pre>
                        <p className="mt-2">{t('settings.storage.retentionHint')}</p>
                    </details>
                </div>
            </SettingsSection> : null}
            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => void query.refetch()}
                    disabled={query.isFetching}
                    className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50"
                >
                    {query.isFetching ? t('settings.storage.refreshing') : t('settings.storage.refresh')}
                </button>
            </div>
        </SettingsPageContent>
    )
}
