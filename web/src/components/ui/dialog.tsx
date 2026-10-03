import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'
import { CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import { useGlassSurface } from '@/themes/glass/GlassScene'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    closeButtonClassName?: string
}

export const DialogContent = React.forwardRef<
    HTMLDivElement,
    DialogContentProps
>(({ className, closeButtonClassName, children, ...props }, ref) => {
    const { t } = useTranslation()
    const glassRef = useGlassSurface<HTMLDivElement>()
    const [contentElement, setContentElement] = React.useState<HTMLDivElement | null>(null)
    const contentRef = React.useCallback((element: HTMLDivElement | null) => {
        setContentElement(element)
        glassRef(element)
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
    }, [glassRef, ref])
    // Radix mounts Content only when opened. Track that DOM lifecycle so a
    // reopened dialog receives current keyboard geometry and fresh listeners.
    React.useLayoutEffect(() => {
        if (!contentElement) return
        const viewport = window.visualViewport
        const update = () => {
            contentElement.style.setProperty('--dialog-visible-height', `${viewport?.height ?? window.innerHeight}px`)
            contentElement.style.setProperty('--dialog-visible-top', `${viewport?.offsetTop ?? 0}px`)
        }
        update()
        viewport?.addEventListener('resize', update)
        viewport?.addEventListener('scroll', update)
        window.addEventListener('resize', update)
        return () => {
            viewport?.removeEventListener('resize', update)
            viewport?.removeEventListener('scroll', update)
            window.removeEventListener('resize', update)
        }
    }, [contentElement])
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="app-dialog-overlay fixed inset-0 z-50 bg-black/50" />
            <DialogPrimitive.Content
                ref={contentRef}
                className={cn(
                    'app-glass app-dialog fixed left-1/2 top-1/2 z-50 w-[calc(100vw-24px)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-[var(--app-dialog-bg)] p-4 shadow-2xl',
                    className
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close
                    className={cn(
                        'app-dialog-close absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        closeButtonClassName
                    )}
                    aria-label={t('button.close')}
                >
                    <CloseIcon className="h-4 w-4" />
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    )
})
DialogContent.displayName = 'DialogContent'

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    // pr-12 reserves space for the absolutely-positioned close button (top-right)
    // so long/breaking titles don't wrap underneath the tap target.
    <div className={cn('flex flex-col space-y-1.5 pr-12 text-center sm:text-left', className)} {...props} />
)

export const DialogTitle = React.forwardRef<
    HTMLHeadingElement,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn('text-base font-semibold leading-none tracking-tight', className)}
        {...props}
    />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = React.forwardRef<
    HTMLParagraphElement,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn('text-sm text-[var(--app-hint)]', className)}
        {...props}
    />
))
DialogDescription.displayName = 'DialogDescription'
