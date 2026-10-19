import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import { safeStringify } from '@hapi/protocol'
import { CodexSubagentHistory } from './codexSubagentHistory'
import { projectSubagentTranscript } from './codexSubagentTranscript'
import { MarkdownRenderer } from './MarkdownRenderer'
import { CodeBlock } from './CodeBlock'
import { ToolCard } from './ToolCard/ToolCard'

export function CodexSubagentDialog(props: {
    api: ApiClient
    parentSessionId: string
    threadId: string
    title: string
    path?: string
    role?: string
    isOpen: boolean
    onClose: () => void
}) {
    const { t } = useTranslation()
    const auth = props.api.getAuthToken()
    const history = useMemo(() => new CodexSubagentHistory(props.api, props.parentSessionId, props.threadId, auth), [props.api, props.parentSessionId, props.threadId, auth])
    const state = useSyncExternalStore(history.subscribe, history.get)
    const { page, loading, error } = state
    const entries = useMemo(() => projectSubagentTranscript(page?.messages ?? []), [page?.messages])
    const viewport = useRef<HTMLDivElement>(null)
    const followScroll = useRef(true)
    const geometry = useRef<{ height: number; top: number; head?: string; tail?: string } | undefined>(undefined)
    useLayoutEffect(() => {
        const node = viewport.current
        if (!node) return
        const previous = geometry.current, head = entries[0]?.message.id, tail = entries.at(-1)?.message.id
        if (previous && head !== previous.head && tail === previous.tail) node.scrollTop = previous.top + node.scrollHeight - previous.height
        else if (followScroll.current && state.following) node.scrollTop = node.scrollHeight
        geometry.current = { height: node.scrollHeight, top: node.scrollTop, head, tail }
    }, [entries, state.following])
    useEffect(() => {
        if (!props.isOpen) return
        followScroll.current = true; geometry.current = undefined
        const synchronize = () => {
            const active = document.visibilityState !== 'hidden' && navigator.onLine !== false
            history.setActive(active)
            if (active) void history.refresh()
        }
        synchronize()
        const interval = setInterval(synchronize, 2000)
        document.addEventListener('visibilitychange', synchronize)
        window.addEventListener('online', synchronize); window.addEventListener('offline', synchronize)
        return () => {
            clearInterval(interval); history.setActive(false)
            document.removeEventListener('visibilitychange', synchronize)
            window.removeEventListener('online', synchronize); window.removeEventListener('offline', synchronize)
        }
    }, [history, props.isOpen])
    const latest = () => { followScroll.current = true; void history.loadLatest() }
    return (
        <Dialog open={props.isOpen} onOpenChange={open => { if (!open) props.onClose() }}>
            <DialogContent className="flex max-w-3xl max-h-[calc(100dvh-24px)] flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{props.title}</DialogTitle>
                    <DialogDescription>{t('sessions.nativeSubagentReadOnly')}</DialogDescription>
                </DialogHeader>
                <div className="min-w-0 text-xs text-[var(--app-hint)]">
                    <code className="block overflow-x-auto whitespace-nowrap">{props.threadId}</code>
                    {props.role ? <span>{props.role}</span> : null}
                    {props.path ? <code className="block overflow-x-auto whitespace-nowrap">{props.path}</code> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {page?.hasMore ? <Button variant="outline" disabled={loading} onClick={() => void history.loadEarlier()}>{t('sessions.subagentLoadEarlier')}</Button> : null}
                    <Button variant="outline" disabled={loading} onClick={latest}>{t('sessions.subagentLatest')}</Button>
                    <span className="text-xs text-[var(--app-hint)]">{t(state.following ? 'sessions.subagentFollowing' : 'sessions.subagentHistoryPaused')}</span>
                </div>
                {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
                {loading ? <p role="status" className="text-sm text-[var(--app-hint)]">{t('sessions.subagentLoading')}</p> : null}
                {state.bounded ? <p className="text-xs text-[var(--app-hint)]">{t('sessions.subagentBounded')}</p> : null}
                {state.restarted ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('sessions.subagentRestarted')}</p> : null}
                {page && page.messages.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('sessions.subagentEmpty')}</p> : null}
                <div ref={viewport} className="min-h-0 space-y-3 overflow-y-auto overscroll-contain" onScroll={event => {
                    const node = event.currentTarget
                    followScroll.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
                    geometry.current = { height: node.scrollHeight, top: node.scrollTop, head: entries[0]?.message.id, tail: entries.at(-1)?.message.id }
                }}>
                    {entries.map(({ message, tool, incomplete }) => <article key={message.id} data-native-subagent-message={message.id}
                        className="min-w-0 rounded-lg border border-[var(--app-border)] p-3">
                        <div className="mb-1 flex gap-2 text-xs text-[var(--app-hint)]"><span>{t(`sessions.subagentRole.${message.role}`)}</span>
                            {message.createdAt ? <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString()}</time> : null}</div>
                        {tool && !incomplete ? <ToolCard api={props.api} sessionId={props.parentSessionId} metadata={null} terminalToolDisplayMode="detailed" disabled readOnly onDone={() => {}} block={tool} />
                            : tool ? <details><summary className="cursor-pointer text-sm">{message.toolName} · {t('sessions.subagentResultPending')}</summary>
                                <CodeBlock code={safeStringify(tool.tool.input)} language="json" scrollY /></details>
                            : message.kind === 'reasoning' ? <details><summary className="cursor-pointer text-sm">{t('sessions.subagentReasoning')}</summary><MarkdownRenderer content={message.text} standalone /></details>
                            : message.role === 'tool' ? <CodeBlock code={message.text} language="text" scrollY />
                            : <MarkdownRenderer content={message.text} standalone />}
                    </article>)}
                </div>
            </DialogContent>
        </Dialog>
    )
}
