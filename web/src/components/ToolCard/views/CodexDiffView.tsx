import { useMemo } from 'react'
import type { ToolViewProps } from './_all'
import { isObject } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { capPatchFiles, parseUnifiedPatch } from '../patchPresentation'
import { UnifiedPatch } from './UnifiedPatch'
import { useTranslation } from '@/lib/use-translation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

function CodexDiffView(props: ToolViewProps) {
    const { t } = useTranslation()
    const input = props.block.tool.input
    const raw = isObject(input) && typeof input.unified_diff === 'string' ? input.unified_diff : null
    const parsed = useMemo(() => raw === null ? null : parseUnifiedPatch(raw), [raw])
    const shown = useMemo(() => parsed ? capPatchFiles(parsed, props.surface === 'dialog' ? 5000 : 20) : null, [parsed, props.surface])
    if (raw === null) return null
    if (!shown) return <CodeBlock code={raw} language="diff" collapseLongContent={props.surface !== 'dialog'} />
    return <div className="space-y-2">
        <UnifiedPatch files={shown.files} showWrapToggle />
        {shown.truncated ? <div className="text-xs text-[var(--app-hint)]">{t('tool.patch.capped', { count: props.surface === 'dialog' ? 5000 : 20 })}</div> : null}
        {props.surface === 'dialog' ? <CodeBlock code={raw} title={t('tool.patch.raw')} language="diff" collapseLongContent scrollY /> : null}
    </div>
}

// ToolCard deliberately leaves this preview outside its detail trigger so the
// diff can own its controls without nesting buttons or opening on a wrap click.
export function CodexDiffCompactView(props: ToolViewProps) {
    const { t } = useTranslation()
    if (!isObject(props.block.tool.input) || typeof props.block.tool.input.unified_diff !== 'string') return null
    return <Dialog>
        <div className="space-y-2">
            <DialogTrigger asChild>
                <button type="button" aria-label={t('tool.patch.openPreview')} className="text-xs text-[var(--app-link)] focus-visible:outline focus-visible:outline-2">
                    {t('diff.view')}
                </button>
            </DialogTrigger>
            <CodexDiffView {...props} surface="inline" />
        </div>
        <DialogContent className="max-w-5xl" aria-describedby={undefined}>
            <DialogHeader><DialogTitle>{t('diff.title')}</DialogTitle></DialogHeader>
            <div className="mt-3 max-h-[75vh] overflow-auto"><CodexDiffView {...props} surface="dialog" /></div>
        </DialogContent>
    </Dialog>
}
export const CodexDiffFullView = CodexDiffView
