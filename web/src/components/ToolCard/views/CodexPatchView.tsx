import { useMemo, useState } from 'react'
import type { ToolViewProps } from './_all'
import { CodeBlock } from '@/components/CodeBlock'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useCodeWrap } from '@/hooks/useCodeWrap'
import { useTranslation } from '@/lib/use-translation'
import { safeStringify } from '@hapi/protocol'
import { capPatchFiles, codexFileChanges, MAX_PATCH_RENDERED_LINES, type CodexFileChange } from '../patchPresentation'
import { UnifiedPatch } from './UnifiedPatch'

function ChangeView({ change }: { change: CodexFileChange }) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const { codeWrap, setCodeWrap } = useCodeWrap()
    const [rawOpen, setRawOpen] = useState(false)
    const shown = useMemo(() => change.files ? capPatchFiles(change.files) : null, [change.files])
    return <section className="min-w-0 space-y-2" aria-label={change.path || t('tool.patch.unknown')}>
        <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-sm" title={change.path}>{change.path || t('tool.patch.unknown')}</div>
                <div className="text-xs text-[var(--app-hint)]">{t(`tool.patch.${change.kind}`)}</div>
                {change.movePath ? <div className="break-all font-mono text-xs">→ {change.movePath}</div> : null}
            </div>
            <button type="button" className="text-xs text-[var(--app-link)]" onClick={() => void copy(change.raw)}>{copied ? t('tool.patch.copied') : t('tool.patch.copy')}</button>
            {shown ? <button type="button" className="text-xs text-[var(--app-link)]" aria-pressed={codeWrap} onClick={() => setCodeWrap(!codeWrap)}>{t('tool.patch.wrap')}</button> : null}
        </div>
        {shown ? <>
            <UnifiedPatch files={shown.files} />
            {shown.truncated ? <div role="status" className="text-xs text-[var(--app-hint)]">{t('tool.patch.capped', { count: MAX_PATCH_RENDERED_LINES })}</div> : null}
            <button type="button" className="text-xs text-[var(--app-link)]" aria-expanded={rawOpen} onClick={() => setRawOpen(value => !value)}>{t('tool.patch.raw')}</button>
            {rawOpen ? <CodeBlock code={change.raw} title={t('tool.patch.raw')} language={change.kind === 'update' ? 'diff' : 'text'} scrollY /> : null}
        </> : <CodeBlock code={change.raw} title={t('tool.patch.raw')} language={change.kind === 'unknown' ? 'json' : 'diff'} scrollY />}
    </section>
}

export function CodexPatchView(props: ToolViewProps) {
    const { t } = useTranslation()
    const changes = useMemo(() => codexFileChanges(props.block.tool.input, props.block.tool.result), [props.block.tool.input, props.block.tool.result])
    if (!changes) return <CodeBlock code={safeStringify(props.block.tool.input)} language="json" title={t('tool.patch.raw')} scrollY />
    if (changes.length === 0) return <div className="text-sm text-[var(--app-hint)]">{t('tool.patch.empty')}</div>
    return <div className="min-w-0 space-y-4">{changes.map((change, index) => <ChangeView key={`${index}:${change.path}`} change={change} />)}</div>
}

export function CodexPatchCompactView(props: ToolViewProps) {
    const { t } = useTranslation()
    // Compact cards list paths without parsing every diff during chat streaming.
    const changes = useMemo(() => codexFileChanges(props.block.tool.input, props.block.tool.result, false), [props.block.tool.input, props.block.tool.result])
    if (!changes) return null
    return <div className="space-y-1 font-mono text-xs">
        {changes.slice(0, 6).map((change, index) => <div key={index} className="break-all" title={change.path}>
            <span className="mr-2 text-[var(--app-hint)]">{t(`tool.patch.${change.kind}`)}</span>{change.path}
        </div>)}
        {changes.length > 6 ? <div className="text-[var(--app-hint)]">{t('tool.patch.more', { count: changes.length - 6 })}</div> : null}
        {changes.length === 0 ? <div className="text-[var(--app-hint)]">{t('tool.patch.empty')}</div> : null}
    </div>
}
