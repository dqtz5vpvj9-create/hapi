import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type Page = Awaited<ReturnType<ApiClient['getCodexSubagentMessages']>>

export function CodexSubagentDialog(props: {
    api: ApiClient
    parentSessionId: string
    threadId: string
    title: string
    isOpen: boolean
    onClose: () => void
}) {
    const { t } = useTranslation()
    const [page, setPage] = useState<Page | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (!props.isOpen) return
        const controller = new AbortController()
        setPage(null)
        setError(null)
        setLoading(true)
        void props.api.getCodexSubagentMessages(props.parentSessionId, props.threadId, { limit: 40, signal: controller.signal })
            .then(result => { if (!controller.signal.aborted) setPage(result) })
            .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [props.api, props.parentSessionId, props.threadId, props.isOpen])

    const loadEarlier = async () => {
        if (!page?.hasMore || page.before === null || loading) return
        setLoading(true)
        setError(null)
        try {
            const earlier = await props.api.getCodexSubagentMessages(props.parentSessionId, props.threadId, { limit: 40, before: page.before })
            setPage(current => current ? { ...earlier, messages: [...earlier.messages, ...current.messages] } : earlier)
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
        } finally { setLoading(false) }
    }
    return (
        <Dialog open={props.isOpen} onOpenChange={open => { if (!open) props.onClose() }}>
            <DialogContent className="max-w-3xl max-h-[calc(100dvh-24px)] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{props.title}</DialogTitle>
                    <DialogDescription>{t('sessions.nativeSubagentHistory')}</DialogDescription>
                </DialogHeader>
                {page?.hasMore ? <Button variant="outline" disabled={loading} onClick={() => void loadEarlier()}>{t('sessions.subagentLoadEarlier')}</Button> : null}
                {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
                {loading ? <p role="status" className="text-sm text-[var(--app-hint)]">{t('sessions.subagentLoading')}</p> : null}
                {page && page.messages.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('sessions.subagentEmpty')}</p> : null}
                <div className="space-y-3">
                    {page?.messages.map(message => <article key={message.id} data-native-subagent-message={message.id}
                        className="min-w-0 rounded-lg border border-[var(--app-border)] p-3">
                        <div className="mb-1 text-xs text-[var(--app-hint)]">{t(`sessions.subagentRole.${message.role}`)}</div>
                        <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">{message.text}</div>
                    </article>)}
                </div>
            </DialogContent>
        </Dialog>
    )
}
