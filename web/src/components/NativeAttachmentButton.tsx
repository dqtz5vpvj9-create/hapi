import { forwardRef, useEffect, useInsertionEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useOptionalAppContext } from '@/lib/app-context'
import { NativeAttachmentError, pickNativeAttachments, type NativeAttachmentSource } from '@/lib/nativeAttachments'
import { useTranslation } from '@/lib/use-translation'

type NativeAttachmentButtonProps = ComponentPropsWithoutRef<'button'> & {
    onFiles: (files: File[], isCurrent: () => boolean) => void | Promise<void>
    selectionScope?: unknown
}

function SourceIcon({ photos }: { photos?: boolean }) {
    return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {photos ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>
            : <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z" /><path d="M13 3v7h7M8 14h8M8 17h6" /></>}
    </svg>
}

export const NativeAttachmentButton = forwardRef<HTMLButtonElement, NativeAttachmentButtonProps>(
    ({ onFiles, selectionScope, disabled, onClick, children, ...buttonProps }, ref) => {
        const { t } = useTranslation()
        const app = useOptionalAppContext()
        const [open, setOpen] = useState(false)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState<unknown>(null)
        const pendingRef = useRef(false)
        const disabledRef = useRef(disabled)
        disabledRef.current = disabled
        const generationRef = useRef(0)
        const controllerRef = useRef<AbortController | null>(null)

        // Match the browser primitive's composer ownership and also invalidate
        // a result when a retained draft switches to a different hub/account.
        useInsertionEffect(() => () => {
            generationRef.current += 1
            controllerRef.current?.abort()
        }, [selectionScope, app?.api, app?.baseUrl])
        useEffect(() => {
            setOpen(false)
            setError(null)
            setBusy(false)
        }, [selectionScope, app?.api, app?.baseUrl])

        const select = async (source: NativeAttachmentSource) => {
            if (disabledRef.current || pendingRef.current) return
            pendingRef.current = true
            setBusy(true)
            setError(null)
            const generation = generationRef.current
            const controller = new AbortController()
            controllerRef.current = controller
            const isCurrent = () => generationRef.current === generation
                && !controller.signal.aborted && !disabledRef.current
            try {
                const files = await pickNativeAttachments(source, controller.signal)
                if (!isCurrent()) return
                if (files.length) await onFiles(files, isCurrent)
                if (isCurrent()) setOpen(false)
            } catch (cause) {
                if (isCurrent()) setError(cause)
            } finally {
                pendingRef.current = false
                if (controllerRef.current === controller) controllerRef.current = null
                if (generationRef.current === generation) setBusy(false)
            }
        }

        const errorMessage = error instanceof NativeAttachmentError
            ? error.code === 'too-large' ? t('attachments.picker.tooLarge', { name: error.fileName ?? '' })
                : error.code === 'busy' ? t('attachments.picker.busy')
                    : t('attachments.picker.unreadable', { name: error.fileName ?? '' })
            : error instanceof Error ? error.message
                : typeof error === 'string' ? error
                    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
                        ? error.message : t('attachments.picker.failed')

        return <>
            <button {...buttonProps} ref={ref} type="button" disabled={disabled || busy}
                onClick={event => {
                    onClick?.(event)
                    if (event.defaultPrevented || disabledRef.current || pendingRef.current) return
                    setError(null)
                    setOpen(true)
                }}>{children}</button>
            <Dialog open={open} onOpenChange={value => {
                if (!value) {
                    controllerRef.current?.abort()
                    generationRef.current += 1
                    setBusy(false)
                }
                setOpen(value)
            }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t('attachments.picker.title')}</DialogTitle>
                        <DialogDescription>{t('attachments.picker.description')}</DialogDescription>
                    </DialogHeader>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                        {(['photos', 'files'] as const).map(source => <button key={source} type="button"
                            disabled={disabled || busy} onClick={() => void select(source)}
                            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-sm font-medium transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50">
                            <SourceIcon photos={source === 'photos'} />
                            {t(source === 'photos' ? 'attachments.picker.photos' : 'attachments.picker.files')}
                        </button>)}
                    </div>
                    {busy ? <p className="mt-3 text-sm text-[var(--app-hint)]" role="status">{t('attachments.picker.loading')}</p> : null}
                    {error !== null ? <p className="mt-3 break-words text-sm text-red-500" role="alert">{errorMessage}</p> : null}
                </DialogContent>
            </Dialog>
        </>
    },
)
NativeAttachmentButton.displayName = 'NativeAttachmentButton'
