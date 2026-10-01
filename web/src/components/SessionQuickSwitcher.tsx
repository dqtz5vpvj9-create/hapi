import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { buildSessionSearchScoreIndex, sortSessionsBySearchRelevance } from '@/lib/sessionListSearch'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

export function SessionQuickSwitcher(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    sessions: SessionSummary[]
    machineLabelsById: Record<string, string>
    onSelect: (id: string) => void
}) {
    const { t } = useTranslation()
    const [query, setQuery] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const previousFocus = useRef<HTMLElement | null>(null)
    const results = useMemo(() => {
        const index = buildSessionSearchScoreIndex(props.sessions, query, id => id ? props.machineLabelsById[id] ?? id : '')
        return sortSessionsBySearchRelevance(
            query.trim() ? props.sessions.filter(session => index.matchedIds.has(session.id)) : props.sessions,
            index,
        )
    }, [props.sessions, props.machineLabelsById, query])
    const selectedIndex = Math.max(0, results.findIndex(session => session.id === selectedId))
    const selected = results[selectedIndex]

    useEffect(() => {
        if (props.open) {
            setQuery('')
            setSelectedId(null)
        }
    }, [props.open])

    useEffect(() => {
        listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
    }, [selected?.id])

    const select = (id: string) => {
        props.onOpenChange(false)
        props.onSelect(id)
    }

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent
                className="max-w-xl"
                onOpenAutoFocus={() => {
                    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
                }}
                onCloseAutoFocus={event => {
                    if (previousFocus.current?.isConnected) {
                        event.preventDefault()
                        previousFocus.current.focus()
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t('sessions.quickSwitch.title')}</DialogTitle>
                    <DialogDescription>{t('sessions.quickSwitch.hint')}</DialogDescription>
                </DialogHeader>
                <input
                    className="mt-4 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-base outline-none focus:border-[var(--app-link)]"
                    role="combobox"
                    aria-label={t('sessions.search.placeholder')}
                    aria-expanded="true"
                    aria-controls="quick-session-results"
                    aria-autocomplete="list"
                    aria-activedescendant={selected ? `quick-session-${selected.id}` : undefined}
                    placeholder={t('sessions.search.placeholder')}
                    value={query}
                    onChange={event => { setQuery(event.target.value); setSelectedId(null) }}
                    onKeyDown={event => {
                        if (event.nativeEvent.isComposing) return
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault()
                            if (results.length) {
                                const offset = event.key === 'ArrowDown' ? 1 : -1
                                setSelectedId(results[(selectedIndex + offset + results.length) % results.length].id)
                            }
                        } else if (event.key === 'Enter' && selected) {
                            event.preventDefault()
                            select(selected.id)
                        }
                    }}
                />
                <div ref={listRef} id="quick-session-results" role="listbox" aria-label={t('sessions.quickSwitch.title')} className="mt-2 max-h-[50dvh] overflow-y-auto">
                    {results.map((session, index) => {
                        const machineId = session.metadata?.machineId
                        const machine = machineId ? props.machineLabelsById[machineId] ?? machineId.slice(0, 8) : ''
                        return (
                            <div
                                key={session.id}
                                id={`quick-session-${session.id}`}
                                role="option"
                                aria-selected={index === selectedIndex}
                                onClick={() => select(session.id)}
                                className={`cursor-pointer rounded-lg px-3 py-2 ${index === selectedIndex ? 'bg-[var(--app-subtle-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'}`}
                            >
                                <div className="truncate text-sm font-medium">{getSessionTitle(session)}</div>
                                <div className="truncate text-xs text-[var(--app-hint)]">{[machine, session.metadata?.path].filter(Boolean).join(' · ')}</div>
                            </div>
                        )
                    })}
                    {results.length === 0 ? <p className="p-4 text-sm text-[var(--app-hint)]">{t('sessions.search.noResults')}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    )
}
