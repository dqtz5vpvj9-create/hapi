import { useEffect, useId, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import type { FileManagerDialogState } from './file-manager-types'

export function FileManagementDialog(props: {
    state: FileManagerDialogState | null
    busy: boolean
    error: string | null
    onClose: () => void
    onSubmit: (value: string) => void | Promise<void>
    onInspectAgain: () => void
}) {
    const { t } = useTranslation()
    const inputId = useId()
    const [value, setValue] = useState('')
    const state = props.state
    useEffect(() => {
        if (!state) return
        setValue(state.action === 'rename' ? state.sources[0]?.name ?? ''
            : state.action === 'move' || state.action === 'copy' ? state.sources.length === 1 ? state.sources[0]?.path ?? '' : '.'
            : '')
    }, [state?.id])
    const title = state?.action === 'create-file' ? t('files.manage.newFile')
        : state?.action === 'create-directory' ? t('files.manage.newFolder')
        : t(`files.manage.${state?.action ?? 'rename'}`)
    const creating = state?.action === 'create-file' || state?.action === 'create-directory'
    const moving = state?.action === 'move' || state?.action === 'copy'
    const deleting = state?.action === 'delete'
    const count = state?.sources.reduce((total, source) => total + source.entry.entryCount, 0) ?? 0
    return (
        <Dialog open={state !== null} onOpenChange={open => { if (!open && !props.busy) props.onClose() }}>
            <DialogContent onEscapeKeyDown={event => { if (props.busy) event.preventDefault() }} onPointerDownOutside={event => { if (props.busy) event.preventDefault() }}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {deleting ? t('files.manage.deleteDescription', { count: state?.sources.length ?? 0 })
                            : creating ? t('files.manage.newAt', { path: state?.parent || t('files.manage.root') })
                            : t('files.manage.relativeHint')}
                    </DialogDescription>
                </DialogHeader>
                <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void props.onSubmit(value) }}>
                    {state?.sources.length ? <ul className="max-h-40 overflow-auto rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-xs">
                        {state.sources.map(source => <li key={source.path} className="break-all py-1" title={source.entry.path}>{source.entry.path}</li>)}
                    </ul> : null}
                    {deleting ? <p className="text-xs text-[var(--app-hint)]">{t('files.manage.deleteEntries', { count })}</p>
                        : <div className="space-y-1.5">
                            <label htmlFor={inputId} className="block text-sm font-medium">
                                {moving ? t(state && state.sources.length > 1 ? 'files.manage.destinationFolder' : 'files.manage.destination') : t('files.manage.name')}
                            </label>
                            <input
                                id={inputId} autoFocus value={value} disabled={props.busy}
                                onChange={event => setValue(event.target.value)}
                                onFocus={event => { if (state?.action === 'rename') { const dot = value.lastIndexOf('.'); event.target.setSelectionRange(0, dot > 0 && state.sources[0]?.kind === 'file' ? dot : value.length) } }}
                                autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--app-link)]"
                            />
                        </div>}
                    {props.error ? <div role="alert" className="rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
                        {props.error}
                        {!creating ? <button type="button" disabled={props.busy} onClick={props.onInspectAgain} className="mt-2 block underline">{t('files.manage.refreshInspection')}</button> : null}
                    </div> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={props.onClose} disabled={props.busy}>{t('files.manage.cancel')}</Button>
                        <Button type="submit" variant={deleting ? 'destructive' : 'default'} disabled={props.busy || (!deleting && !value)}>
                            {props.busy ? t('files.manage.working') : creating ? t('files.manage.create') : title}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
