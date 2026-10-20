import { useMutation, useQueryClient } from '@tanstack/react-query'
import { classifySessionActivity } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { SettingsSection } from './SettingsPrimitives'

type Action = 'standard' | 'pause'
export function bulkTargets(sessions: SessionSummary[], action: Action) {
    return sessions.filter(session => action === 'standard'
        ? session.metadata?.flavor === 'codex' && isFastServiceTier(session.serviceTier)
        : classifySessionActivity(session).running)
}

export async function runSessionBulkAction(api: Pick<ApiClient, 'getSessions' | 'setServiceTier' | 'abortSession'>, action: Action) {
    // Fetch at click time: a cached settings page must not decide which turns to stop.
    const { sessions } = await api.getSessions()
    const targets = bulkTargets(sessions, action)
    const results = await Promise.allSettled(targets.map(session => action === 'standard'
        ? api.setServiceTier(session.id, 'standard')
        : api.abortSession(session.id)))
    return {
        total: targets.length,
        succeeded: results.filter(result => result.status === 'fulfilled').length,
        failures: results.flatMap((result, index) => result.status === 'rejected' ? [{
            id: targets[index].id,
            name: targets[index].metadata?.name || targets[index].metadata?.path || targets[index].id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }] : []),
    }
}

export function SessionBulkActions() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const mutation = useMutation({
        mutationFn: async (action: Action) => {
            if (!api) throw new Error('API unavailable')
            return runSessionBulkAction(api, action)
        },
        onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.sessions }) },
    })
    return <SettingsSection title={t('settings.bulk.title')} description={t('settings.bulk.description')}>
        <div className="space-y-3 p-3">
            <div className="flex flex-wrap gap-2">
                {(['standard', 'pause'] as const).map(action => <button key={action} type="button"
                    className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm disabled:opacity-50"
                    disabled={!api || mutation.isPending} onClick={() => mutation.mutate(action)}>
                    {t(action === 'standard' ? 'settings.bulk.standard' : 'settings.bulk.pause')}
                </button>)}
            </div>
            <div role="status" aria-live="polite" className="text-sm">
                {mutation.isPending ? t('settings.bulk.pending') : mutation.data ? t('settings.bulk.result', { n: mutation.data.succeeded, total: mutation.data.total }) : null}
            </div>
            {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
            {!mutation.isPending && mutation.data?.failures.map(failure => <p key={failure.id} className="break-words text-sm text-[var(--app-hint)]">{failure.name}: {failure.error}</p>)}
        </div>
    </SettingsSection>
}
