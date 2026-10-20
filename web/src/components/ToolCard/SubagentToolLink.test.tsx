import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ToolCallBlock } from '@/chat/types'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { I18nProvider } from '@/lib/i18n-context'
import { matchSubagentToolTargets, SubagentToolLink } from './SubagentToolLink'

const state = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@tanstack/react-router', async importOriginal => {
    const actual = await importOriginal<typeof import('@tanstack/react-router')>()
    return { ...actual, useNavigate: () => state.navigate }
})

const metadata: SessionMetadataSummary = {
    path: '/project',
    host: 'machine',
    flavor: 'dsh',
    dshSubagents: [
        { sessionId: 'session-ada', name: 'Ada', mode: 'continuable', activity: 'running', createdAt: 1 },
        { sessionId: 'session-bruno', label: 'bruno-worker', mode: 'one-shot', activity: 'inactive', createdAt: 2 },
    ],
}

function block(toolName: string, input: unknown, result?: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: `block-${toolName}`,
        localId: null,
        createdAt: 0,
        children: [],
        tool: {
            id: 'tool-1',
            name: toolName,
            input,
            result,
            state: 'completed',
            createdAt: 0,
            completedAt: 1,
        },
    } as unknown as ToolCallBlock
}

function chatContext(overrides: Partial<HappyChatContextValue> = {}): HappyChatContextValue {
    return {
        api: {} as ApiClient,
        sessionId: 'parent',
        metadata,
        terminalToolDisplayMode: 'detailed',
        showSessionSummaryInChat: false,
        disabled: true,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'transient-stop',
        ...overrides,
    }
}

function renderLink(toolBlock: ToolCallBlock, overrides: Partial<HappyChatContextValue> = {}) {
    return render(
        <HappyChatProvider value={chatContext(overrides)}>
            <I18nProvider>
                <SubagentToolLink block={toolBlock} />
            </I18nProvider>
        </HappyChatProvider>,
    )
}

beforeEach(() => {
    state.navigate = vi.fn()
})

afterEach(() => {
    cleanup()
})

describe('matchSubagentToolTargets', () => {
    it('matches a child by its session id in the tool result', () => {
        const targets = matchSubagentToolTargets(
            block('send_message', { name: 'Ada' }, { sessionId: 'session-ada', delivered: true }),
            metadata.dshSubagents!,
        )
        expect(targets.map(target => target.sessionId)).toEqual(['session-ada'])
    })

    it('falls back to teammate names and labels', () => {
        expect(matchSubagentToolTargets(
            block('wait_agent', { agents: ['Ada'] }, { statuses: [] }),
            metadata.dshSubagents!,
        ).map(target => target.sessionId)).toEqual(['session-ada'])
    })

    it('ignores unrelated tools and payloads', () => {
        expect(matchSubagentToolTargets(block('Bash', { command: 'ls session-ada' }), metadata.dshSubagents!)).toEqual([])
        expect(matchSubagentToolTargets(block('spawn_teammate', { prompt: 'No child named here' }), metadata.dshSubagents!)).toEqual([])
        expect(matchSubagentToolTargets(block('spawn_teammate', { prompt: 'Ada' }), [])).toEqual([])
    })
})

describe('SubagentToolLink', () => {
    it('renders an open-subagent entry and navigates to the child route', () => {
        renderLink(block('spawn_teammate', { name: 'Ada', prompt: 'Review the diff' }))
        const link = screen.getByRole('button', { name: /Open subagent Ada/ })
        expect(link.getAttribute('data-subagent-link')).toBe('session-ada')
        fireEvent.click(link)
        expect(state.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/subagents/$subagentId',
            params: { sessionId: 'parent', subagentId: 'session-ada' },
        })
    })

    it('degrades silently without chat metadata or a matching child', () => {
        const { container: withoutMetadata } = renderLink(block('spawn_teammate', { name: 'Ada' }), { metadata: null })
        expect(withoutMetadata.querySelector('[data-subagent-link]')).toBeNull()

        const { container: withoutMatch } = renderLink(block('spawn_teammate', { prompt: 'nothing to match' }))
        expect(withoutMatch.querySelector('[data-subagent-link]')).toBeNull()
    })
})
