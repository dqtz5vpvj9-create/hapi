import { useMemo, useState } from 'react'
import { capSearchRows, retainedSearchCount, searchRows, type SearchPresentation, type SearchRow } from '../searchPresentation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'

export function SearchResultCard({ model, interactive }: { model: SearchPresentation; interactive: boolean }) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const [expanded, setExpanded] = useState(false)
    const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
    const rows = useMemo(() => searchRows(model.data, interactive ? collapsed : new Set()), [model.data, interactive, collapsed])
    const shown = capSearchRows(rows, expanded && interactive ? 5000 : 16)
    const retained = retainedSearchCount(model.data)
    const summary = model.data.kind === 'paths'
        ? t('tool.search.paths', { count: retained })
        : t('tool.search.matches', { count: retained, files: model.data.files.length })
    const rowView = (row: SearchRow) => {
        if (row.type === 'path') return <div className="break-all px-2 py-0.5 font-mono text-xs" key={row.key}>{row.path}</div>
        if (row.type === 'match') return <div className="flex gap-3 px-2 font-mono text-xs leading-5" key={row.key}>
            <span className="min-w-8 shrink-0 text-right text-[var(--app-hint)]">{row.lineNumber}</span>
            <span className="min-w-0 whitespace-pre-wrap break-all">{row.line || '\u00a0'}</span>
        </div>
        const content = <><span className="min-w-0 break-all font-mono">{row.path}</span><span className="shrink-0 text-[var(--app-hint)]">{row.count}</span></>
        return interactive ? <button key={row.key} type="button" className="flex w-full items-start justify-between gap-3 bg-[var(--app-subtle-bg)] px-2 py-1 text-left text-xs" aria-expanded={!row.collapsed}
            onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(row.fileIndex)) next.delete(row.fileIndex); else next.add(row.fileIndex); return next })}>{content}</button>
            : <div key={row.key} className="flex justify-between gap-3 bg-[var(--app-subtle-bg)] px-2 py-1 text-xs">{content}</div>
    }
    return <section className="min-w-0 overflow-hidden rounded-lg border border-[var(--app-border)]" aria-label={t('tool.search.results')}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--app-border)] px-2 py-2 text-xs text-[var(--app-hint)]">
            <span>{summary}{model.truncated ? ` · ${t('tool.search.truncated', { count: retained, total: model.total ?? retained })}` : ''}</span>
            {interactive && retained > 0 ? <button type="button" className="text-[var(--app-link)]" onClick={() => void copy(model.copyText)}>{copied ? t('tool.patch.copied') : t('tool.search.copy')}</button> : null}
        </div>
        {retained === 0 ? <div className="px-2 py-3 text-sm text-[var(--app-hint)]">{t('tool.search.empty')}</div> : null}
        {shown.head.map(rowView)}
        {shown.hidden > 0 ? <div className="px-2 py-1 text-center text-xs text-[var(--app-hint)]">
            {interactive && !expanded ? <button type="button" className="text-[var(--app-link)]" onClick={() => setExpanded(true)}>{t('tool.search.expand', { count: shown.hidden })}</button> : t('tool.search.hidden', { count: shown.hidden })}
        </div> : null}
        {shown.tail.map(rowView)}
        {interactive && expanded ? <button type="button" className="w-full px-2 py-1 text-xs text-[var(--app-link)]" onClick={() => setExpanded(false)}>{t('tool.search.collapse')}</button> : null}
        {model.recovery ? <div className="whitespace-pre-wrap break-all border-t border-[var(--app-border)] px-2 py-2 text-xs text-[var(--app-hint)]">{model.recovery}</div> : null}
    </section>
}
