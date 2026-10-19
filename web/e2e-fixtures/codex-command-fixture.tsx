import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import { ToolGroupCard } from '../src/components/ToolCard/ToolGroupCard'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { I18nProvider } from '../src/lib/i18n-context'
import type { ApiClient } from '../src/api/client'
import type { ToolCallBlock } from '../src/chat/types'

const params = new URLSearchParams(location.search)
const command = 'ls -ld /home/chris/.agentsview /home/chris/miniconda3 /android; df -h\nsystemctl --user list-units --type=service --state=running --no-pager'
const powershellCommand = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg needle src"'
const reportLine = `Browser reports: ${Array.from({ length: 18 }, (_, index) => `browser-report-${String(index + 1).padStart(2, '0')}.json`).join(' | ')}`
const output = ['API acceptance saved: True', 'DETAIL_OUTPUT_ONLY', 'Verification complete.', reportLine].join('\n')
const startedAt = Date.now() - 1200
const api = {} as ApiClient
const context: HappyChatContextValue = {
    api,
    sessionId: 'command-demo',
    metadata: null,
    terminalToolDisplayMode: params.has('compact') ? 'compact' : 'detailed',
    showSessionSummaryInChat: false,
    disclosureState: new Map(),
    disabled: false,
    onRefresh: () => {},
    hasMoreMessages: false,
    isSyncingTail: false,
    isLoadingMoreMessages: false,
    loadOlderMessagesPreservingScroll: async () => 'loaded',
}

function makeBlock(stage: 'running' | 'appended' | 'finished'): ToolCallBlock {
    const streaming = params.has('streaming')
    const finished = !streaming || stage === 'finished'
    const failed = params.has('failed') || (streaming && finished)
    const stdout = streaming && stage === 'running' ? 'Waiting for browser report…' : output
    return {
        kind: 'tool-call',
        id: 'command-demo',
        localId: null,
        createdAt: startedAt,
        children: [],
        tool: {
            id: 'command-demo',
            name: params.has('bash') ? 'Bash' : 'CodexBash',
            // Shared Codex completion can be completed even with a nonzero exit.
            state: finished ? 'completed' : 'running',
            input: { command: params.has('powershell') ? powershellCommand : ['/bin/bash', '-lc', command] },
            result: params.has('unavailable') ? undefined : params.has('empty') ? {
                status: 'completed', exit_code: 0, stdout: '', stderr: '',
            } : {
                type: finished ? 'exec_command_end' : 'exec_command_output_delta',
                stdout,
                // Shared command results carry both fields; do not render twice.
                output: stdout,
                ...(failed ? {
                    stderr: 'Browser verification failed: expected chat content was not rendered.',
                    error: 'DIAGNOSTIC_OUTPUT_ONLY: report artifact capture stopped.',
                } : {}),
                ...(finished ? { status: 'completed', exit_code: failed ? 1 : 0 } : { status: 'running' }),
            },
            description: null,
            createdAt: startedAt,
            startedAt,
            completedAt: finished ? startedAt + 1200 : null,
            execStartedAt: null,
            execCompletedAt: null,
        },
    }
}

function Fixture() {
    const [stage, setStage] = useState<'running' | 'appended' | 'finished'>('running')
    const block = makeBlock(stage)
    const secondBlock: ToolCallBlock = {
        ...block,
        id: 'command-demo-second',
        tool: {
            ...block.tool,
            id: 'command-demo-second',
            input: { command: 'printf "Second command\\n"' },
            result: { stdout: 'SECOND_COMMAND_OUTPUT', exit_code: 0 },
        },
    }
    const group = params.has('group') ? buildVisibleChatBlocks([block, secondBlock], { hasMoreMessages: false })[0] : null
    if (group?.kind === 'tool-group' && params.has('group-open')) group.defaultOpen = true

    const content = (
        <main className={`mx-auto max-w-xl space-y-4 p-4 ${params.has('touch-scroll') ? 'pt-48 pb-[120vh]' : ''}`} data-testid="command-fixture">
            {params.has('streaming') ? (
                <div className="flex gap-3">
                    <button type="button" onClick={() => setStage('appended')}>Append output</button>
                    <button type="button" onClick={() => setStage('finished')}>Finish command</button>
                </div>
            ) : null}
            {group?.kind === 'tool-group' ? (
                <ToolGroupCard block={group} metadata={null} />
            ) : (
                <ToolCard
                    api={api}
                    sessionId="command-demo"
                    metadata={null}
                    terminalToolDisplayMode={context.terminalToolDisplayMode}
                    disabled={false}
                    onDone={() => {}}
                    block={block}
                />
            )}
        </main>
    )
    return (
        <I18nProvider>
            <HappyChatProvider value={context}>
                {params.has('chat-scroll') ? (
                    <div className="app-scroll-y chat-scroll-y h-full overflow-x-hidden" data-testid="chat-scroll-fixture">
                        {content}
                    </div>
                ) : content}
            </HappyChatProvider>
        </I18nProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />)
