import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import type { SubagentPromptDelivery, SubagentSource } from '@/components/subagent'

/**
 * Append-only composer for continuable DSH children. The delivery choice maps
 * to the DSH prompt operation: `queue` runs after the current turn, `steer`
 * interrupts and injects. Stop is independent and calls the interrupt
 * operation while the child is executing.
 */
export function SubagentComposer(props: { source: SubagentSource; running: boolean }) {
    const { t } = useTranslation()
    const [text, setText] = useState('')
    const [delivery, setDelivery] = useState<SubagentPromptDelivery>('queue')
    const [sending, setSending] = useState(false)
    const [stopping, setStopping] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const canSend = text.trim().length > 0 && !sending && Boolean(props.source.prompt)
    const canStop = props.running && !stopping && Boolean(props.source.interrupt)

    const send = async () => {
        if (!props.source.prompt || !canSend) return
        setSending(true)
        setError(null)
        try {
            await props.source.prompt(text.trim(), delivery)
            setText('')
        } catch (cause) {
            setError(cause instanceof Error && cause.message ? cause.message : t('sessions.subagentSendFailed'))
        } finally {
            setSending(false)
        }
    }

    const stop = async () => {
        if (!props.source.interrupt || !canStop) return
        setStopping(true)
        setError(null)
        try {
            await props.source.interrupt()
        } catch (cause) {
            setError(cause instanceof Error && cause.message ? cause.message : t('sessions.subagentStopFailed'))
        } finally {
            setStopping(false)
        }
    }

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void send()
    }

    return (
        <form onSubmit={submit} className="flex flex-col gap-2 border-t border-[var(--app-border)] px-3 py-2" data-subagent-composer>
            {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
            <label htmlFor="subagent-composer-input" className="sr-only">{t('sessions.subagentSendPlaceholder')}</label>
            <textarea
                id="subagent-composer-input"
                value={text}
                onChange={event => setText(event.target.value)}
                placeholder={t('sessions.subagentSendPlaceholder')}
                rows={2}
                className="min-h-[2.5rem] w-full resize-none rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            />
            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-[var(--app-hint)]">
                    {t('sessions.subagentDelivery')}
                    <select
                        value={delivery}
                        onChange={event => setDelivery(event.target.value === 'steer' ? 'steer' : 'queue')}
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-xs text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <option value="queue">{t('sessions.subagentDelivery.queue')}</option>
                        <option value="steer">{t('sessions.subagentDelivery.steer')}</option>
                    </select>
                </label>
                <span aria-hidden="true" className="min-w-0 flex-1" />
                {props.running && props.source.interrupt ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void stop()} disabled={!canStop} data-subagent-stop>
                        {t('sessions.subagentStop')}
                    </Button>
                ) : null}
                <Button type="submit" size="sm" disabled={!canSend} data-subagent-send>
                    {t('sessions.subagentSend')}
                </Button>
            </div>
        </form>
    )
}
