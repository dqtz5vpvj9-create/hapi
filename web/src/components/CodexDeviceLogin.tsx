import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CodexDeviceLogin as Login, CodexAccountSummary } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export function CodexDeviceLogin(props: { api: ApiClient; machineId: string; onComplete?: (account: CodexAccountSummary) => void }) {
    const { t } = useTranslation()
    const queries = useQueryClient()
    const [login, setLogin] = useState<Login | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [label, setLabel] = useState('')
    const [copied, setCopied] = useState(false)
    const generation = useRef(0)
    const completed = useRef(props.onComplete)
    completed.current = props.onComplete
    useEffect(() => { generation.current++; setLogin(null); setError(''); setBusy(false); return () => { generation.current++ } }, [props.machineId])
    useEffect(() => {
        if (!login || login.status !== 'pending') return
        let stopped = false
        let timer: ReturnType<typeof setTimeout>
        const poll = async () => {
            try {
                const response = await props.api.codexDeviceLogin(props.machineId, 'get', login.id)
                if (stopped) return
                if (!response.success || !response.login) throw new Error(response.error || t('codex.login.failed'))
                const next = response.login
                setLogin(next)
                setError('')
                if (next.status === 'completed' && next.account) {
                    await queries.invalidateQueries({ queryKey: queryKeys.machineCodexAccounts(props.machineId) })
                    if (!stopped) completed.current?.(next.account)
                }
                if (next.status !== 'pending') return
            } catch (reason) {
                if (stopped) return
                setError(reason instanceof Error ? reason.message : t('codex.login.failed'))
            }
            if (!stopped) timer = setTimeout(poll, 2000)
        }
        timer = setTimeout(poll, 1000)
        return () => { stopped = true; clearTimeout(timer) }
    }, [login?.id, login?.status, props.api, props.machineId, queries, t])
    const request = async (action: 'start' | 'cancel') => {
        const current = ++generation.current
        setBusy(true); setError(''); setCopied(false)
        try {
            const response = await props.api.codexDeviceLogin(props.machineId, action, login?.id, label.trim() || undefined)
            if (generation.current !== current) return
            if (!response.success || !response.login) throw new Error(response.error || t('codex.login.failed'))
            setLogin(response.login)
        } catch (reason) {
            if (generation.current === current) setError(reason instanceof Error ? reason.message : t('codex.login.failed'))
        } finally { if (generation.current === current) setBusy(false) }
    }
    return <div className="my-2 rounded-lg border border-[var(--app-divider)] p-3 text-sm">
        {login?.status === 'pending' ? <>
            <p>{t('codex.login.instructions')}</p>
            <div className="my-3 flex flex-wrap items-center gap-3">
                <code className="select-all text-xl font-bold tracking-widest">{login.userCode}</code>
                <button type="button" className="min-h-9 rounded-md border border-[var(--app-divider)] px-3 py-1 text-[var(--app-link)]" onClick={() => { void navigator.clipboard.writeText(login.userCode).then(() => setCopied(true)).catch(() => setError(t('codex.login.copyFailed'))) }}>{t(copied ? 'codex.login.copied' : 'codex.login.copy')}</button>
                <a className="inline-flex min-h-9 items-center text-[var(--app-link)] underline" href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{t('codex.login.open')}</a>
            </div>
            <p role="status" className="text-[var(--app-hint)]">{t('codex.login.waiting')} · {new Date(login.expiresAt).toLocaleTimeString()}</p>
            <button type="button" className="mt-2 min-h-9 rounded-md border border-[var(--app-divider)] px-3 py-1 disabled:opacity-50" disabled={busy} onClick={() => void request('cancel')}>{t('button.cancel')}</button>
        </> : <>
            {login ? <p role="status">{login.status === 'completed' ? `${t('codex.login.completed')} ${login.account?.label ?? ''}` : login.error || t(login.status === 'expired' ? 'codex.login.expired' : 'codex.login.cancelled')}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t('codex.login.label')} placeholder={t('codex.login.label')} value={label} maxLength={80} onChange={event => setLabel(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1" />
                <button type="button" disabled={busy} onClick={() => void request('start')} className="min-h-9 rounded-md border border-[var(--app-divider)] px-3 py-1 text-[var(--app-link)] disabled:opacity-50">{t(busy ? 'codex.login.starting' : 'codex.login.add')}</button>
            </div>
        </>}
        {error ? <p role="alert" className="mt-2 text-red-600">{error}</p> : null}
    </div>
}
