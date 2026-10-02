import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState } from 'react'
import type { CodexGoalRequest } from '@hapi/protocol/apiTypes'
import type { ThreadGoal } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function isGoalComposerText(text: string): boolean {
    return /^\s*\/goal(?:\s|$)/i.test(text)
}

export function ComposerGoalControl(props: {
    goal: ThreadGoal | null
    disabled: boolean
    onAction?: (request: CodexGoalRequest) => Promise<ThreadGoal | null>
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState(false)
    const [objective, setObjective] = useState('')
    const [goal, setGoal] = useState(props.goal)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(false)
    const [confirmClear, setConfirmClear] = useState(false)
    const inFlight = useRef(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const editorRef = useRef<HTMLTextAreaElement>(null)
    const openingEditor = useRef(false)
    useEffect(() => setGoal(props.goal), [props.goal])
    const unavailable = props.disabled || !props.onAction
    const trimmed = objective.trim()
    const length = [...objective].length
    const actionClass = 'flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-50'
    const apply = async (request: CodexGoalRequest) => {
        if (inFlight.current || unavailable) return
        inFlight.current = true
        setBusy(true)
        setError(false)
        try {
            const next = await props.onAction!(request)
            setGoal(next)
            setConfirmClear(false)
            if (request.action === 'set') setEditing(false)
        } catch {
            setError(true)
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }
    const edit = () => {
        setObjective(goal?.objective ?? '')
        setError(false)
        openingEditor.current = true
        setOpen(false)
        setEditing(true)
    }
    return (
        <>
            <Popover.Root open={open} onOpenChange={next => {
                setOpen(next)
                setConfirmClear(false)
                setError(false)
            }}>
                <Popover.Trigger asChild>
                    <button ref={triggerRef} type="button" aria-label={t('composer.goal.control')}
                        disabled={props.disabled || busy}
                        className={`flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-xs disabled:opacity-50 ${goal ? 'bg-[var(--app-link-muted)] text-[var(--app-link)]' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}>
                        {t('composer.goal.mode')}
                        {goal ? <span aria-label={t(`session.status.goal.${goal.status}`)} className={`h-1.5 w-1.5 rounded-full ${goal.status === 'active' ? 'bg-emerald-500' : goal.status === 'complete' ? 'bg-[var(--app-hint)]' : 'bg-amber-500'}`} /> : null}
                        <span aria-hidden="true">⌄</span>
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12}
                        aria-label={t('composer.goal.control')}
                        onCloseAutoFocus={event => {
                            if (openingEditor.current) { event.preventDefault(); openingEditor.current = false }
                        }}
                        onInteractOutside={event => { if (busy) event.preventDefault() }}
                        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
                        className="z-[60] w-72 max-w-[calc(100vw-1.5rem)] max-h-[min(70dvh,28rem)] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-[var(--app-fg)] shadow-lg">
                        <div className="px-3 py-2">
                            <div className="text-xs font-semibold text-[var(--app-hint)]">{t('composer.goal.current')}</div>
                            {goal ? <>
                                <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm">{goal.objective}</p>
                                <p className="mt-1 text-xs text-[var(--app-hint)]">
                                    {t(`session.status.goal.${goal.status}`)}
                                    {goal.tokensUsed > 0 || goal.tokenBudget != null ? ` · ${goal.tokensUsed.toLocaleString()}${goal.tokenBudget != null ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tokens` : ''}
                                </p>
                            </> : <p className="mt-1 text-xs text-[var(--app-hint)]">{t('composer.goal.notLoaded')}</p>}
                        </div>
                        <button type="button" className={actionClass} disabled={busy || unavailable} onClick={edit}>
                            {t(goal ? 'composer.goal.edit' : 'composer.goal.create')}
                        </button>
                        {goal ? <>
                            <button type="button" className={actionClass} disabled={busy || unavailable}
                                onClick={() => void apply({ action: goal.status === 'active' ? 'pause' : 'resume' })}>
                                {t(goal.status === 'active' ? 'composer.goal.pause' : 'composer.goal.resume')}
                            </button>
                            {confirmClear ? <div className="rounded-md bg-[var(--app-subtle-bg)] p-3">
                                <p className="mb-2 text-sm">{t('composer.goal.clearConfirm')}</p>
                                <div className="flex gap-2">
                                    <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmClear(false)}>{t('button.cancel')}</Button>
                                    <Button type="button" variant="destructive" disabled={busy || unavailable} onClick={() => void apply({ action: 'clear' })}>{t('composer.goal.clear')}</Button>
                                </div>
                            </div> : <button type="button" className={`${actionClass} text-red-600`} disabled={busy || unavailable}
                                onClick={() => setConfirmClear(true)}>{t('composer.goal.clear')}</button>}
                        </> : null}
                        <button type="button" className={actionClass} disabled={busy || unavailable} onClick={() => void apply({ action: 'get' })}>{t('composer.goal.inspect')}</button>
                        {unavailable ? <p className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('composer.goal.unavailable')}</p> : null}
                        {busy ? <p role="status" className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('composer.goal.working')}</p> : null}
                        {error ? <p role="alert" className="px-3 py-2 text-sm text-red-600">{t('composer.goal.error')}</p> : null}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            <Dialog open={editing} onOpenChange={next => { if (!busy) setEditing(next) }}>
                <DialogContent className="flex max-h-[80dvh] flex-col gap-4 overflow-y-auto text-[var(--app-fg)]"
                    closeButtonClassName={busy ? 'hidden' : undefined}
                    onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
                    onInteractOutside={event => { if (busy) event.preventDefault() }}
                    onOpenAutoFocus={event => {
                        event.preventDefault()
                        editorRef.current?.focus()
                        editorRef.current?.setSelectionRange(objective.length, objective.length)
                    }}
                    onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus() }}>
                    <DialogHeader>
                        <DialogTitle>{t(goal ? 'composer.goal.edit' : 'composer.goal.create')}</DialogTitle>
                        <DialogDescription>{t('composer.goal.editorHint')}</DialogDescription>
                    </DialogHeader>
                    <div>
                        <label htmlFor="goal-objective" className="mb-2 block text-sm font-medium">{t('composer.goal.objective')}</label>
                        <textarea ref={editorRef} id="goal-objective" value={objective} rows={6} disabled={busy}
                            placeholder={t('composer.goal.placeholder')}
                            aria-describedby="goal-length" aria-invalid={length > 4000 || undefined}
                            onChange={event => { setObjective(event.target.value); setError(false) }}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                                    event.preventDefault()
                                    if (trimmed && length <= 4000) void apply({ action: 'set', objective: trimmed })
                                }
                            }}
                            className="block min-h-36 max-h-[40dvh] w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 text-base leading-relaxed text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-60" />
                        <p id="goal-length" className={`mt-1 text-right text-xs ${length > 4000 ? 'text-red-600' : 'text-[var(--app-hint)]'}`}>{length.toLocaleString()} / 4,000</p>
                    </div>
                    {error ? <p role="alert" className="text-sm text-red-600">{t('composer.goal.error')}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>{t('button.cancel')}</Button>
                        <Button type="button" disabled={busy || unavailable || !trimmed || length > 4000}
                            onClick={() => void apply({ action: 'set', objective: trimmed })}>
                            {t(busy ? 'composer.goal.saving' : 'composer.goal.save')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
