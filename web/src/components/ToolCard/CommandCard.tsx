import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { formatDuration } from '@/chat/presentation'
import { useChatDisclosure, useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { CodeBlock } from '@/components/CodeBlock'
import { ContentParts, richToolParts, toolArtifactCount } from '@/components/Artifacts/ContentParts'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { TerminalIcon } from './icons'
import { cleanCommandOutput, getCommandPresentation } from './commandPresentation'
import { NativeDependencyStatus, useNativeToolDetail } from './nativeDependencies'
import { toolDurationMs } from './toolDuration'
import { getCodexCommandText, singleLineCommand } from '@/lib/codex-command-label'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { isObject } from '@hapi/protocol'

export const TERMINAL_TOOL_NAMES = new Set(['Bash', 'CodexBash', 'shell_command', 'run_shell_command', 'ssh'])

type CommandCardProps = {
    block: ToolCallBlock
    showSummary: boolean
    renderDetails: (block: ToolCallBlock) => ReactNode
    renderTiming: (block: ToolCallBlock) => ReactNode
    renderStatus: (state: ToolCallBlock['tool']['state']) => ReactNode
    children?: ReactNode
}

function Chevron(props: { open: boolean }) {
    return <svg aria-hidden="true" className={cn('h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none', props.open && 'rotate-90')} viewBox="0 0 16 16" fill="none">
        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
}

/** One dependency consumer owns both surfaces, so closing a dialog cannot
 * cancel an inline reader's request. It is mounted only after expansion. */
function CommandDetails(props: Pick<CommandCardProps, 'block' | 'renderDetails' | 'renderTiming'> & {
    id: string
    fullOpen: boolean
    onResolved: (source: ToolCallBlock, resolved: ToolCallBlock) => void
}) {
    const { t } = useTranslation()
    const hasLiveResult = props.block.tool.result != null
    const detail = useNativeToolDetail(props.block, !hasLiveResult || props.fullOpen)
    const block = useMemo(() => {
        if (!detail.available) return props.block
        // Native dependency entries can predate a streamed result. A new live
        // result owns the command's state and output; hydrated children remain
        // available to the full inspector.
        return hasLiveResult ? {
            ...detail.block,
            ...props.block,
            children: detail.block.children.length ? detail.block.children : props.block.children,
        } : detail.block
    }, [detail.available, detail.block, hasLiveResult, props.block])
    const command = useMemo(() => getCommandPresentation(block.tool, {
        outputDeferred: detail.available && !detail.complete,
    }), [block.tool, detail.available, detail.complete])
    const argv = isObject(block.tool.input) ? block.tool.input.command ?? block.tool.input.cmd : null
    const lastArgument = Array.isArray(argv) ? argv.at(-1) : null
    // The existing label parser recognizes shell argv wrappers. Show their
    // script with real newlines here; the full inspector retains every argv
    // field. String invocations stay verbatim, including PowerShell startup.
    const commandText = typeof lastArgument === 'string' && getCodexCommandText(block.tool.input) === lastArgument.trim()
        ? lastArgument : command.command
    const richParts = richToolParts(block.tool.result)
    const additionalParts = richParts?.filter(part => part.type !== 'text' || command.output === null)

    useEffect(() => {
        if (detail.available && !hasLiveResult) props.onResolved(props.block, block)
    }, [block, detail.available, hasLiveResult, props.block, props.onResolved])

    const outputPlaceholder = command.outputState === 'empty'
        ? t('tool.command.noOutput')
        : block.tool.state === 'running' ? t('tool.command.waitingOutput')
            : command.outputState === 'deferred' ? t('tool.command.deferredOutput') : t('tool.command.unavailableOutput')

    return <>
        <section
            id={props.id}
            role="region"
            aria-label={t('tool.command.details')}
            data-hapi-command-details="true"
            className="ml-6 mt-1 min-w-0 space-y-3 border-l border-[var(--app-border)] pl-3 pb-2 [&_[data-hapi-code-block]_button]:min-h-8 [&_[data-hapi-code-block]_button]:min-w-8"
        >
            <div data-hapi-share-exclude="true" className="min-w-0 space-y-3">
                <NativeDependencyStatus {...detail} />
                {props.renderTiming(block)}
                {command.cwd ? <div className="min-w-0 text-xs text-[var(--app-hint)]">
                    <span className="mr-2 font-medium">{t('tool.command.cwd')}</span>
                    <span className="break-all font-mono">{command.cwd}</span>
                </div> : null}
                {commandText ? <CodeBlock code={commandText} language="bash" title={t('tool.command.command')} scrollLabel={t('tool.command.command')} scrollY maxHeight={240} /> : null}
                {command.output ? <CodeBlock code={cleanCommandOutput(command.output)} copyText={command.output} language="text" title={t('tool.command.output')} scrollLabel={t('tool.command.output')} scrollY maxHeight={320} /> : !richParts ? (
                    <p className="text-xs text-[var(--app-hint)]">{outputPlaceholder}</p>
                ) : null}
            </div>
            {additionalParts?.length ? <ContentParts parts={additionalParts} /> : null}
        </section>
        <DialogContent className="max-w-3xl" closeButtonClassName="top-2" aria-describedby={undefined}>
            <DialogHeader className="text-left"><DialogTitle>{t('tool.command.details')}</DialogTitle></DialogHeader>
            <NativeDependencyStatus {...detail} />
            {props.renderDetails(block)}
        </DialogContent>
    </>
}

export function CommandCard(props: CommandCardProps) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useChatDisclosure(props.block.id, false)
    const [fullOpen, setFullOpen] = useState(false)
    const [resolved, setResolved] = useState<{ source: ToolCallBlock; block: ToolCallBlock } | null>(null)
    const onResolved = useCallback((source: ToolCallBlock, block: ToolCallBlock) => {
        setResolved(previous => previous?.source === source && previous.block === block ? previous : { source, block })
    }, [])
    const displayBlock = resolved?.source === props.block ? resolved.block : props.block
    const command = useMemo(() => getCommandPresentation(displayBlock.tool), [displayBlock.tool])
    const summaryCommand = getCodexCommandText(displayBlock.tool.input) ?? command.command ?? props.block.tool.name
    const chat = useOptionalHappyChatContext()
    const active = chat?.activeExecutionToolId === props.block.id
    const state = command.isError ? 'error' : displayBlock.tool.state
    // DSH emits every command as its own card. Keep its live command open and
    // fold completed ones, while Codex retains its existing grouped behavior.
    const compactCompleted = chat?.metadata?.flavor === 'dsh'
    const running = compactCompleted && (state === 'running' || active)
    const wasRunning = useRef(running)
    useEffect(() => {
        if (!compactCompleted) return
        if (running) setExpanded(true)
        else if (wasRunning.current) setExpanded(false)
        wasRunning.current = running
    }, [compactCompleted, running, setExpanded])
    const prefix = state === 'error' ? t('tool.command.failed')
        : state === 'running' ? t('tool.command.running')
            : state === 'pending' ? t('tool.command.pending') : t('tool.command.ran')
    const status = state === 'error' && command.exitCode !== null
        ? `${prefix} (${t('tool.command.exit', { code: command.exitCode })})` : prefix
    const duration = toolDurationMs(displayBlock.tool)
    const artifactCount = toolArtifactCount(displayBlock.tool.result)
    const id = useId()
    const placeholder = artifactCount ? t('artifact.groupCount', { n: artifactCount })
        : command.outputState === 'empty' ? t('tool.command.noOutput')
        : state === 'running' ? t('tool.command.waitingOutput') : t('tool.command.unavailableOutput')

    return <Dialog open={fullOpen} onOpenChange={setFullOpen}>
        <Card data-hapi-command="true" data-hapi-tool-state={state} className="min-w-0 max-w-full overflow-hidden rounded-md border-0 bg-transparent py-1 shadow-none">
            <button
                type="button"
                data-hapi-share-exclude="true"
                aria-expanded={expanded}
                aria-controls={expanded ? id : undefined}
                onClick={() => setExpanded(value => !value)}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md text-left text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                <Chevron open={expanded} />
                <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
                <span
                    title={summaryCommand}
                    data-execution-active={active || undefined}
                    data-execution-label={active ? t('session.item.running') : undefined}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap font-mono text-sm', active && 'hapi-execution-sweep', state === 'error' && 'text-red-600')}
                >{status} {singleLineCommand(summaryCommand)}</span>
                <span className={cn('shrink-0', state === 'error' ? 'text-red-600' : state === 'completed' ? 'text-emerald-600' : undefined)} aria-label={state}>{props.renderStatus(state)}</span>
                <time className="shrink-0 text-xs tabular-nums opacity-65" dateTime={new Date(props.block.createdAt).toISOString()}>
                    {new Date(props.block.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </time>
            </button>

            {!expanded && props.showSummary && (!compactCompleted || running) ? <div data-hapi-share-exclude="true" className="ml-6 min-w-0 border-l border-[var(--app-border)] pl-3">
                {command.preview ? <div
                    role="region"
                    aria-label={t('tool.command.preview')}
                    tabIndex={0}
                    data-hapi-command-preview="true"
                    className="min-w-0 max-w-full overflow-x-auto rounded-sm text-xs leading-5 text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                ><pre className="m-0 w-max min-w-full font-mono">{command.preview.text}</pre></div>
                    : <p className="py-0.5 font-mono text-xs text-[var(--app-hint)]">{placeholder}</p>}
            </div> : null}

            {expanded || props.showSummary ? <div data-hapi-share-exclude="true" className="ml-6 flex min-w-0 flex-wrap items-center gap-x-3 pl-3 text-xs text-[var(--app-hint)]">
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={expanded ? id : undefined}
                    onClick={() => setExpanded(value => !value)}
                    className="min-h-9 rounded px-1 text-[var(--app-link)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    {t(expanded ? 'tool.command.hideDetails' : 'tool.command.showDetails')}
                    {!expanded && command.preview?.hiddenLineCount ? <span className="ml-2 text-[var(--app-hint)]">{t('tool.command.moreLines', { count: command.preview.hiddenLineCount })}</span> : null}
                </button>
                {expanded ? <DialogTrigger asChild><button type="button" className="min-h-9 rounded px-1 hover:text-[var(--app-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{t('tool.command.openFullDetails')}</button></DialogTrigger> : null}
                {!expanded && duration !== null ? <span className="ml-auto tabular-nums">{formatDuration(duration)}</span> : null}
            </div> : null}

            {expanded || fullOpen ? <CommandDetails block={props.block} id={id} fullOpen={fullOpen} onResolved={onResolved} renderDetails={props.renderDetails} renderTiming={props.renderTiming} /> : null}
            {props.children}
        </Card>
    </Dialog>
}
