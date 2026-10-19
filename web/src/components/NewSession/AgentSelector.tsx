import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CREATABLE_AGENT_FLAVORS, getFlavorLabel, type AgentAvailabilityEntry } from '@hapi/protocol'
import type { AgentType } from './types'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

export function AgentSelector(props: {
    agent: AgentType
    agents: readonly AgentType[]
    availability: readonly AgentAvailabilityEntry[]
    isDisabled: boolean
    isRefreshing?: boolean
    onRefresh: () => void
    onAgentChange: (value: AgentType) => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const otherAgents = CREATABLE_AGENT_FLAVORS.filter((agent) => !props.agents.includes(agent))

    useEffect(() => {
        if (props.isDisabled || otherAgents.length === 0) setOpen(false)
    }, [props.isDisabled, otherAgents.length])

    const unavailableReason = (agent: AgentType) => {
        const entry = props.availability.find((candidate) => candidate.agent === agent)
        if (!entry) return t('newSession.agentNotReported')
        if (entry.reason === 'not_found') return t('newSession.agentCommandNotFound')
        if (entry.reason === 'invalid_configuration') return t('newSession.agentConfigurationInvalid')
        return t('newSession.agentReportedUnavailable')
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('newSession.agent')}
                </label>
                {otherAgents.length > 0 ? (
                    <Popover.Root open={open} onOpenChange={setOpen}>
                        <Popover.Trigger asChild>
                            <button type="button" disabled={props.isDisabled}
                                className="-my-1.5 min-h-11 rounded-lg px-2 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-50">
                                {t('newSession.otherAgents', { count: otherAgents.length })}
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content align="end" sideOffset={8} collisionPadding={12}
                                aria-label={t('newSession.otherAgentsTitle')}
                                className="z-50 flex max-h-[min(70vh,32rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-[var(--app-fg)] shadow-lg">
                                <div className="flex items-center justify-between gap-3">
                                    <h3 className="text-sm font-medium">{t('newSession.otherAgentsTitle')}</h3>
                                    <button type="button" disabled={props.isDisabled || props.isRefreshing} onClick={props.onRefresh}
                                        className="min-h-11 shrink-0 rounded-lg px-2 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50">
                                        {t('newSession.refreshAgents')}
                                    </button>
                                </div>
                                <p className="pb-2 text-xs text-[var(--app-hint)]">{t('newSession.otherAgentsHint')}</p>
                                <ul tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain divide-y divide-[var(--app-divider)]">
                                    {otherAgents.map((agentType) => (
                                        <li key={agentType} className="flex items-start gap-2 py-3">
                                            <AgentFlavorIcon flavor={agentType} className="mt-0.5 h-4 w-4 shrink-0" />
                                            <div className="min-w-0">
                                                <div className="text-sm">{getFlavorLabel(agentType)}{agentType === 'dsh' ? ' (DSH)' : ''}</div>
                                                <p className="mt-0.5 text-xs text-[var(--app-hint)]">{unavailableReason(agentType)}</p>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
                {props.agents.map((agentType) => (
                    <label
                        key={agentType}
                        className="app-new-session-choice-target flex items-center gap-1.5 cursor-pointer"
                    >
                        <input
                            type="radio"
                            name="agent"
                            value={agentType}
                            checked={props.agent === agentType}
                            onChange={() => props.onAgentChange(agentType)}
                            disabled={props.isDisabled}
                            className="accent-[var(--app-link)]"
                        />
                        <AgentFlavorIcon flavor={agentType} className="h-4 w-4 shrink-0" />
                        <span className="text-sm">{getFlavorLabel(agentType)}</span>
                    </label>
                ))}
            </div>
        </div>
    )
}
