import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { DshSubagent } from '@hapi/protocol/schemas'
import { safeStringify } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { useTranslation } from '@/lib/use-translation'

/**
 * Tools that may reference a DSH child session. Codex agent tool names share the
 * same cards, so they are matched too; the link only appears when the payload
 * actually names a child from `metadata.dshSubagents`.
 */
export const SUBAGENT_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
    'spawn_teammate',
    'wait_agent',
    'send_message',
    'subagent_codex',
    'subagent_claude_code',
    'spawn_agent',
    'send_input',
    'resume_agent',
    'followup_task',
    'close_agent',
    'interrupt_agent',
    'list_agents',
    'workflow',
])

function haystackFor(block: ToolCallBlock): string {
    const parts: string[] = []
    if (block.tool.input !== undefined && block.tool.input !== null) {
        parts.push(safeStringify(block.tool.input))
    }
    if (block.tool.result !== undefined && block.tool.result !== null) {
        parts.push(safeStringify(block.tool.result))
    }
    return parts.join('\n')
}

/**
 * Match child catalog entries named by a delegation tool. A session id is the
 * strongest signal; a teammate name is used when the payload only reports names.
 * Ordering follows the catalog so the list stays stable across refreshes.
 */
export function matchSubagentToolTargets(
    block: ToolCallBlock,
    subagents: readonly DshSubagent[],
): DshSubagent[] {
    const linked = subagents
    if (!SUBAGENT_DELEGATION_TOOL_NAMES.has(block.tool.name) || linked.length === 0) {
        return []
    }
    const haystack = haystackFor(block)
    if (!haystack) {
        return []
    }
    const idMatches = linked.filter(agent => haystack.includes(agent.sessionId))
    if (idMatches.length > 0) {
        return idMatches
    }
    return linked.filter(agent => {
        const name = agent.name ?? agent.label
        return Boolean(name && name.trim().length >= 2 && haystack.includes(name))
    })
}

export function SubagentToolLink(props: { block: ToolCallBlock }) {
    const ctx = useOptionalHappyChatContext()
    const matches = useMemo(() => {
        const metadata = ctx?.metadata
        if (!metadata) {
            return []
        }
        return matchSubagentToolTargets(props.block, metadata.dshSubagents ?? [])
    }, [ctx?.metadata, props.block])
    // No parent chat context (or no matching child): degrade silently.
    if (!ctx?.sessionId || matches.length === 0) {
        return null
    }
    return <SubagentToolLinks parentSessionId={ctx.sessionId} matches={matches} />
}

function SubagentToolLinks(props: { parentSessionId: string; matches: DshSubagent[] }) {
    const navigate = useNavigate()
    const { t } = useTranslation()
    return (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1" data-subagent-tool-links>
            {props.matches.map(agent => {
                const title = agent.name || agent.label || agent.sessionId.slice(0, 8)
                return (
                    <button
                        key={agent.sessionId}
                        type="button"
                        data-subagent-link={agent.sessionId}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        title={t('sessions.subagentOpenAria', { title })}
                        onClick={event => {
                            event.stopPropagation()
                            void navigate({
                                to: '/sessions/$sessionId/subagents/$subagentId',
                                params: { sessionId: props.parentSessionId, subagentId: agent.sessionId },
                            })
                        }}
                    >
                        <span aria-hidden="true">↗</span>
                        <span className="truncate">{t('sessions.subagentOpen')}</span>
                        <span className="truncate font-medium">{title}</span>
                    </button>
                )
            })}
        </div>
    )
}
