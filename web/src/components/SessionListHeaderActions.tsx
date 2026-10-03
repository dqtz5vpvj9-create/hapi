import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import { useGlassSurface } from '@/themes/glass/GlassScene'
import { useTranslation } from '@/lib/use-translation'

export function SessionListHeaderActions(props: {
    onSwitch: () => void
    onBrowse?: () => void
    onSettings: () => void
    onNew: () => void
}) {
    const { t } = useTranslation()
    const narrow = useNarrowViewport()
    const [open, setOpen] = useState(false)
    const glass = useGlassSurface<HTMLDivElement>()
    const actions = [
        { label: t('sessions.quickSwitch.title'), title: `${t('sessions.quickSwitch.title')} (Ctrl/Cmd+K)`, action: props.onSwitch },
        ...(props.onBrowse ? [{ label: t('browse.nav'), title: t('browse.nav'), action: props.onBrowse }] : []),
        { label: t('settings.title'), title: t('settings.title'), action: props.onSettings },
    ]
    if (!narrow) return <div className="app-session-router-actions flex items-center gap-2">
        <button type="button" onClick={props.onSwitch} title={`${t('sessions.quickSwitch.title')} (Ctrl/Cmd+K)`} className="min-h-9 rounded-md px-2 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">{t('sessions.quickSwitch.button')}</button>
        {props.onBrowse ? <button type="button" onClick={props.onBrowse} title={t('browse.nav')} aria-label={t('browse.nav')} className="rounded-full p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7h6l2 2h10v11H3zM3 7V4h6l2 3" /></svg>
        </button> : null}
        <button type="button" onClick={props.onSettings} title={t('settings.title')} aria-label={t('settings.title')} className="rounded-full p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></svg>
        </button>
        <button type="button" onClick={props.onNew} className="session-list-new-button flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-link)]" title={t('sessions.new')} aria-label={t('sessions.new')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
    </div>
    return <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild><button type="button" aria-label={t('session.more')} title={t('session.more')}
            className="app-session-header-more flex h-11 w-11 items-center justify-center rounded-full bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
        </button></Popover.Trigger>
        <Popover.Portal><Popover.Content ref={glass} side="bottom" align="end" sideOffset={6} collisionPadding={12}
            className="app-glass app-floating-panel z-50 w-56 max-w-[calc(100vw-24px)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-dialog-bg)] p-2 shadow-lg">
            {actions.map(item => <button key={item.label} type="button" onClick={() => { setOpen(false); item.action() }}
                className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">{item.label}</button>)}
            <button type="button" onClick={() => { setOpen(false); props.onNew() }} className="app-session-mobile-new flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]">{t('sessions.new')}</button>
        </Popover.Content></Popover.Portal>
    </Popover.Root>
}
