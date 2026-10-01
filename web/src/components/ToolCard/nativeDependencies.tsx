import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { useTranslation } from '@/lib/use-translation'
import { reduceChatBlocks } from '@/chat/reducer'

// Dependency bodies never enter the continuous root message window. Keep every
// received identity here: the native producer's bounded cache can evict earlier
// child pages before returning its final response.
type DetailState = { block: ToolCallBlock; loading: boolean; complete: boolean; error: string | null; errorKey?: string; count: number }
type Entry = { state: DetailState; seedIds: string[]; controller?: AbortController; listeners: Set<() => void> }
const AUTO_PAGE_BUDGET = 16

function findTool(blocks: ChatBlock[], id: string): ToolCallBlock | undefined {
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        if (block.id === id) return block
        const child = findTool(block.children, id)
        if (child) return child
    }
    return undefined
}

function containsTool(message: NormalizedMessage, id: string): boolean {
    if (message.role === 'agent') return message.content.some(content => content.type === 'tool-call' && content.id === id)
    if (message.role !== 'event') return false
    const event = message.content as Record<string, unknown>
    if (event.type === 'agent-run-trace' && event.cardId !== id) return Boolean(findTool(reduceChatBlocks([message], null).blocks, id))
    return (event.type === 'agent-run-start' || event.type === 'agent-run-update')
        && (event.cardId === id || `codex-agent:${event.agentId}` === id)
}

// Native nested runs carry an explicit parent thread. The normal chat reducer
// groups each agent's trace, then this detail-only tree attaches nested cards
// using that identity rather than matching prompts or interleaved timestamps.
function projectDetails(messages: NormalizedMessage[]): ChatBlock[] {
    const blocks = reduceChatBlocks(messages, null).blocks
    const parents = new Map<string, string>()
    const declaredParents = new Map<string, string>()
    for (const message of messages) {
        if (message.role !== 'event') continue
        const event = message.content as Record<string, unknown>
        const scope = event.scope as { parentThreadId?: string } | undefined
        if (typeof event.agentId !== 'string' || !scope?.parentThreadId) continue
        parents.set(event.agentId, scope.parentThreadId)
        // The spawning card owns the topology. A detail read of an inner tool
        // may replay its trace with the reader root as the fallback parent.
        if (event.type === 'agent-run-start' || event.type === 'agent-run-update') declaredParents.set(event.agentId, scope.parentThreadId)
    }
    const agents = new Map<string, ToolCallBlock>()
    for (const block of blocks) {
        if (block.kind === 'tool-call' && block.tool.name === 'CodexAgent') {
            const input = block.tool.input as { agentId?: string } | null
            if (input?.agentId) agents.set(input.agentId, block)
        }
    }
    for (const [agentId, parentId] of declaredParents) parents.set(agentId, parentId)
    const nested = new Set<ChatBlock>()
    for (const [agentId, parentId] of parents) {
        const child = agents.get(agentId)
        const parent = agents.get(parentId)
        if (!child || !parent || child === parent) continue
        parent.children = [...parent.children, child].sort((a, b) => a.createdAt - b.createdAt)
        nested.add(child)
    }
    return blocks.filter(block => !nested.has(block))
}

class DependencyDetails {
    private readonly bodies = new Map<string, DecryptedMessage>()
    private readonly entries = new Map<string, Entry>()
    private disposed = false
    constructor(readonly api: ApiClient, readonly sessionId: string, readonly epoch: number, private readonly auth: string | null) {}
    roots: DecryptedMessage[] = []

    entry(block: ToolCallBlock): Entry {
        let entry = this.entries.get(block.id)
        if (!entry) {
            entry = { state: { block, loading: false, complete: false, error: null, count: 0 }, seedIds: [], listeners: new Set() }
            this.entries.set(block.id, entry)
        }
        return entry
    }
    private publish(entry: Entry, patch: Partial<DetailState>) {
        entry.state = { ...entry.state, ...patch }
        for (const listener of entry.listeners) listener()
    }
    private current() { return !this.disposed && this.api.getAuthToken() === this.auth }
    cancel(entry: Entry) {
        entry.controller?.abort()
        entry.controller = undefined
        if (entry.state.loading) this.publish(entry, { loading: false })
    }
    activate() { this.disposed = false }
    dispose() {
        this.disposed = true
        for (const entry of this.entries.values()) this.cancel(entry)
        this.bodies.clear()
    }
    async load(entry: Entry) {
        if (!this.current() || entry.controller || entry.state.complete) return
        // Capture actual raw seed records, not display/tool IDs. Retain the seed
        // while the root reading window moves; nested tools can seed from the
        // already received dependency bodies.
        for (const message of this.roots) {
            const normalized = normalizeDecryptedMessage(message)
            if (normalized && containsTool(normalized, entry.state.block.id)) {
                this.bodies.set(message.id, message)
                if (!entry.seedIds.includes(message.id)) entry.seedIds.push(message.id)
            }
        }
        if (!entry.seedIds.length) {
            for (const message of this.bodies.values()) {
                const normalized = normalizeDecryptedMessage(message)
                if (normalized && containsTool(normalized, entry.state.block.id)) entry.seedIds.push(message.id)
            }
        }
        entry.seedIds = entry.seedIds.slice(-1)
        if (!entry.seedIds.length) {
            this.publish(entry, { error: null, errorKey: 'tool.dependencies.seedMissing' })
            return
        }
        const controller = new AbortController()
        entry.controller = controller
        this.publish(entry, { loading: true, error: null, errorKey: undefined })
        let emptyPages = 0
        try {
            for (let page = 0; page < AUTO_PAGE_BUDGET; page++) {
                const response = await this.api.getMessageDependencies(this.sessionId, entry.seedIds, this.epoch, controller.signal)
                if (controller.signal.aborted || !this.current()) return
                if (response.reset || response.epoch !== this.epoch) {
                    // Never merge another snapshot into a currently open detail.
                    this.publish(entry, { error: null, errorKey: 'tool.dependencies.changed' })
                    return
                }
                let added = 0
                for (const message of response.messages) {
                    if (!this.bodies.has(message.id)) added++
                    this.bodies.set(message.id, message)
                }
                const messages = [...this.bodies.values()].sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
                const normalized = messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
                const block = findTool(projectDetails(normalized), entry.state.block.id) ?? entry.state.block
                this.publish(entry, { block, complete: response.complete, count: this.bodies.size })
                if (response.complete) return
                if (response.issues.some(issue => issue.reason === 'unreadable')) {
                    this.publish(entry, { error: null, errorKey: 'tool.dependencies.unreadable' })
                    return
                }
                emptyPages = added ? 0 : emptyPages + 1
                // A finite burst and a no-progress stop keep malformed/inactive
                // producers from spinning. The reader explicitly continues.
                if (emptyPages >= 2) return
            }
        } catch (error) {
            if (!controller.signal.aborted && this.current()) this.publish(entry, { error: error instanceof Error ? error.message : null, errorKey: error instanceof Error ? undefined : 'tool.dependencies.failed' })
        } finally {
            if (entry.controller === controller) {
                entry.controller = undefined
                if (this.current()) this.publish(entry, { loading: false })
            }
        }
    }
}

const DependencyContext = createContext<DependencyDetails | null>(null)

export function NativeDependencyProvider(props: { api: ApiClient; sessionId: string; epoch: number | null; enabled: boolean; messages: DecryptedMessage[]; children: ReactNode }) {
    const auth = props.api.getAuthToken()
    const details = useMemo(() => props.enabled && props.epoch !== null
        ? new DependencyDetails(props.api, props.sessionId, props.epoch, auth) : null,
    [props.api, props.sessionId, props.epoch, props.enabled, auth])
    if (details) details.roots = props.messages
    useLayoutEffect(() => {
        details?.activate()
        return () => details?.dispose()
    }, [details])
    return <DependencyContext.Provider value={details}>{props.children}</DependencyContext.Provider>
}

export function useNativeToolDetail(block: ToolCallBlock, active = true) {
    const details = useContext(DependencyContext)
    const entry = details?.entry(block)
    const fallback = useMemo<DetailState>(() => ({ block, loading: false, complete: true, error: null, count: 0 }), [block])
    const state = useSyncExternalStore(
        listener => { entry?.listeners.add(listener); return () => { entry?.listeners.delete(listener) } },
        () => entry?.state ?? fallback
    )
    useEffect(() => {
        if (!active || !details || !entry) return
        void details.load(entry)
        return () => details.cancel(entry)
    }, [details, entry, active])
    return { ...state, block: active ? state.block : block, load: () => { if (details && entry) void details.load(entry) }, available: Boolean(details && active) }
}

export function NativeDependencyStatus(props: ReturnType<typeof useNativeToolDetail>) {
    const { t } = useTranslation()
    if (!props.available) return null
    const error = props.errorKey ? t(props.errorKey) : props.error
    return <div className="text-sm text-[var(--app-hint)]" aria-live="polite">
        {props.loading ? <span role="status">{t('tool.dependencies.loading', { count: props.count })}</span> : null}
        {error ? <div role="alert">{error}</div> : null}
        {!props.loading && !props.complete ? <button type="button" className="mt-1 underline" onClick={props.load}>{t(error ? 'tool.dependencies.retry' : 'tool.dependencies.more')}</button> : null}
    </div>
}
