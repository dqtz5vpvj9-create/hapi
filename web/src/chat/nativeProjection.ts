import { isObject } from '@hapi/protocol'
import type { NativeExecution } from '@hapi/protocol/nativeExecution'
import type { ChatBlock, NormalizedMessage } from './types'
import { richToolParts } from '@/components/Artifacts/ContentParts'
import { ProcessGroups, type ProcessItem, STANDARD_PRESENTATION } from './dsh/process-groups'
import { isSubagentToolName } from './subagentTool'
import type { VirtualItem } from '@tanstack/react-virtual'

export function executionOf(block: object): NativeExecution | undefined {
    return 'meta' in block && isObject(block.meta) ? block.meta.nativeExecution as NativeExecution | undefined : undefined
}

export type NativeNode = {
    key: string
    /** A disclosure seat keeps its own identity when its first item changes. */
    messageKey?: string
    block: ChatBlock
    turnKey?: string
    process?: { key: string; answer: string; count: number; open: boolean; control: boolean }
    group?: { key: string; count: number; open: boolean; control: boolean; running: boolean; detail: string }
    hidden: boolean
}

/** DSH MutableChatSource publication contract, adapted to HAPI node payloads.
 * Source: conversation-nodes/chat-snapshot-builder.ts (MIT, ./dsh/LICENSE). */
class NodeSource {
    private listeners = new Set<() => void>()
    private published: NativeNode | undefined
    constructor(private read: () => NativeNode | undefined) { this.published = read() }
    getSnapshot = () => this.read()
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    publish() {
        const next = this.read()
        if (next === this.published) return
        this.published = next
        for (const listener of this.listeners) listener()
    }
}

/** Only references to the existing bounded message window; no second transcript. */
export class NativeChatProjection {
    readonly measurements: { width: number; items: VirtualItem[] } = { width: 0, items: [] }
    disclosureState = new Map<string, boolean>()
    layoutVersion = 0
    order: readonly string[] = []
    blocks: readonly ChatBlock[] = []
    private runtimeBlocks: readonly ChatBlock[] = []
    private publishedRuntimeBlocks = this.runtimeBlocks
    private runtimeListeners = new Set<() => void>()
    getRuntimeBlocks = () => this.runtimeBlocks
    subscribeRuntime = (listener: () => void) => {
        this.runtimeListeners.add(listener)
        return () => { this.runtimeListeners.delete(listener) }
    }
    turnStates: ReadonlyMap<string, NativeExecution['turn']> = new Map()
    private nodes = new Map<string, NativeNode>()
    private sources = new Map<string, NodeSource>()
    aliases = new Map<string, string>()
    private canonical = new WeakMap<ChatBlock, ChatBlock>()
    private input: readonly ChatBlock[] = []
    private messages: readonly NormalizedMessage[] = []
    refreshPresentation() { this.update(this.input, this.messages, true) }
    private expanded = new Map<string, string>()
    private grouping = new ProcessGroups()
    private expandedGroups = new Set<string>()
    private partialTurns = new Set<string>()
    /** Epoch replacement is authoritative; old disclosure and geometry cannot
     * describe the replacement history even when some item IDs survive. */
    resetViewState() {
        this.expanded.clear()
        this.expandedGroups.clear()
        this.partialTurns.clear()
        this.disclosureState.clear()
        this.grouping = new ProcessGroups()
        this.measurements.items = []
        this.measurements.width = 0
    }
    ownerOf = (id: string): string => {
        const key = id.replace(/^hapi-message-/, '')
        return this.aliases.get(key) ?? key
    }
    get = (key: string) => this.nodes.get(key)
    source(key: string) {
        let source = this.sources.get(key)
        if (!source) { source = new NodeSource(() => this.nodes.get(key)); this.sources.set(key, source) }
        return source
    }
    setOpen(turnKey: string, answer: string, open: boolean) {
        if (open) this.expanded.set(turnKey, answer)
        else this.expanded.delete(turnKey)
    }
    setGroupOpen(key: string, open: boolean) {
        if (open) this.expandedGroups.add(key)
        else this.expandedGroups.delete(key)
    }
    /** Explicit reading/navigation may need a part currently inside a disclosure. */
    reveal(key: string): boolean {
        const node = this.get(this.ownerOf(key))
        if (!node) return false
        let changed = false
        if (node.process && !node.process.open) {
            this.setOpen(node.process.key, node.process.answer, true)
            changed = true
        }
        if (node.group && !node.group.open) {
            this.setGroupOpen(node.group.key, true)
            changed = true
        }
        if (changed) { this.refreshPresentation(); this.publish() }
        return changed
    }
    publish() {
        if (this.publishedRuntimeBlocks !== this.runtimeBlocks) {
            this.publishedRuntimeBlocks = this.runtimeBlocks
            for (const listener of this.runtimeListeners) listener()
        }
        for (const [key, source] of this.sources) {
            source.publish()
            if (!this.nodes.has(key)) this.sources.delete(key)
        }
    }
    update(input: readonly ChatBlock[], messages: readonly NormalizedMessage[], presentationChanged = false) {
        if (!presentationChanged && input === this.input && messages === this.messages) return
        this.input = input; this.messages = messages
        const lifecycle = new Map<string, NativeExecution['turn']>()
        for (const message of messages) {
            const native = executionOf(message)
            if (native?.turn) lifecycle.set(`${native.threadId}:${native.turnId}`, native.turn)
        }
        this.turnStates = lifecycle
        const mapped = input.map(block => {
            const native = executionOf(block)
            // The permission channel can expose a question before its history
            // item arrives. Both already share the native tool-call id. Keep
            // that identity when richer turn metadata arrives, or the question
            // remounts and loses the user's in-progress answer.
            if (!native?.itemId || block.kind === 'tool-call') return block
            let canonical = this.canonical.get(block)
            if (!canonical) {
                canonical = { ...block, id: `${native.threadId}:${native.turnId}:${native.itemId}:${block.kind}${block.kind === 'agent-event' ? `:${block.event.type}` : ''}` }
                this.canonical.set(block, canonical)
            }
            return canonical
        })
        this.aliases = new Map()
        for (let i = 0; i < mapped.length; i++) {
            const block = mapped[i], key = `${block.kind}:${block.id}`
            this.aliases.set(input[i].id, key)
            this.aliases.set(`${input[i].kind}:${input[i].id}`, key)
            this.aliases.set(`hapi-reading-${input[i].kind}:${input[i].id}`, key)
            this.aliases.set(`hapi-reading-${input[i].id}`, key)
            this.aliases.set(`hapi-reading-${block.id}`, key)
            this.aliases.set(`hapi-reading-${key}`, key)
            const sourceMeta = input[i].meta
            const sourceId = isObject(sourceMeta) ? sourceMeta.nativeSourceId : undefined
            if (typeof sourceId === 'string') {
                this.aliases.set(sourceId, key)
                this.aliases.set(`${block.kind}:${sourceId}`, key)
                this.aliases.set(`hapi-reading-${block.kind}:${sourceId}`, key)
            }
        }
        // A persisted result can briefly coexist with its live envelope. One
        // native item still owns one seat; replace its value in source order.
        const blocks = [...new Map(mapped.map(block => [`${block.kind}:${block.id}`, block])).values()]
        const turns = new Map<string, ChatBlock[]>()
        for (const block of blocks) {
            const native = executionOf(block)
            if (!native) continue
            const turn = `${native.threadId}:${native.turnId}`
            const rows = turns.get(turn) ?? []
            rows.push(block); turns.set(turn, rows)
        }
        const processes = new Map<string, NonNullable<NativeNode['process']>>()
        const eligibleTurns = new Set<string>()
        for (const key of this.partialTurns) if (!turns.has(key)) this.partialTurns.delete(key)
        for (const [key, rows] of turns) {
            // DSH has a complete turn when deciding whole-turn folding. A
            // bounded HAPI window can discover its beginning later. Keep the
            // already displayed partial turn's presentation for this residency;
            // loading history must not collapse content underneath the reader.
            if (rows[0]?.kind !== 'user-text') this.partialTurns.add(key)
            const state = lifecycle.get(key)
            const answerIndex = rows.findLastIndex(row => row.kind === 'agent-text' && executionOf(row)?.phase === 'final_answer')
            // DSH ChatNodeSeat/ChatGroupSeat: live, aborted, failed and interleaved
            // input stay open. Adaptation: Codex phase replaces DSH answerStep;
            // unknown phase/boundary never grants whole-turn collapse.
            const interleaved = rows.some((row, index) => row.kind === 'user-text' && index > 0)
            const unknownProse = rows.some(row => row.kind === 'agent-text' && !executionOf(row)?.phase)
            if (state && !unknownProse && (state.status === 'inProgress' || answerIndex >= 0)) eligibleTurns.add(key)
            if (!STANDARD_PRESENTATION.foldCompletedTurns || state?.status !== 'completed' || !state.started || !state.ended
                || rows[0]?.kind !== 'user-text' || this.partialTurns.has(key)
                || answerIndex < 0 || interleaved || unknownProse) continue
            const answer = rows[answerIndex].id
            const members = rows.slice(0, answerIndex).filter(isProcessMember)
            if (!members.length) continue
            const process = { key, answer, count: members.length, open: this.expanded.get(key) === answer, control: false }
            // Disclosure belongs to the first process seat. Every seat, including
            // the final answer, retains the same key and parent on settlement.
            for (const member of members) processes.set(member.id, { ...process, control: member === members[0] })
        }
        const groupItems: ProcessItem[] = blocks.flatMap((block, position) => {
            const native = executionOf(block)
            const turn = native && `${native.threadId}:${native.turnId}`
            if (!turn || !eligibleTurns.has(turn)) return []
            return [{ key: block.id, turn, position, kind: isGroupMember(block) ? 'process'
                : block.kind === 'agent-text' ? 'reply' : 'independent' }]
        })
        const closedTurns = new Set([...lifecycle].filter(([, state]) => state?.ended).map(([key]) => key))
        const groups = new Map<string, NonNullable<NativeNode['group']>>()
        const byId = new Map(blocks.map(block => [block.id, block]))
        const grouped = this.grouping.replace(groupItems, closedTurns)
        for (const group of grouped) {
            const rows = group.members.map(id => byId.get(id)!)
            const active = [...rows].reverse().find(row => row.kind === 'tool-call'
                && (row.tool.state === 'running' || row.tool.state === 'pending'))
            const running = !group.closed && active !== undefined
            const detail = active?.kind === 'tool-call'
                ? active.tool.nativeTitle ?? active.tool.description ?? active.tool.name : ''
            const presentation = { key: group.key, count: rows.length, running, detail,
                open: this.expandedGroups.has(group.key), control: false }
            for (const row of rows) groups.set(row.id, { ...presentation, control: row === rows[0] })
        }
        const groupKeys = new Set(grouped.map(group => group.key))
        for (const key of this.expandedGroups) if (!groupKeys.has(key)) this.expandedGroups.delete(key)
        const next = new Map<string, NativeNode>()
        for (const block of blocks) {
            const key = `${block.kind}:${block.id}`, native = executionOf(block)
            const process = processes.get(block.id)
            const group = groups.get(block.id)
            const hidden = Boolean(process && !process.open && !process.control)
                || Boolean((!process || process.open) && group && !group.open && !group.control)
            const previous = this.nodes.get(key)
            next.set(key, previous?.block === block && previous.hidden === hidden
                && sameDisclosure(previous.process, process) && sameDisclosure(previous.group, group) ? previous : {
                key, block, turnKey: native ? `${native.threadId}:${native.turnId}` : undefined, process, group, hidden,
            })
        }
        const blockIds = new Set(blocks.map(block => block.id))
        for (const key of this.disclosureState.keys()) if (!blockIds.has(key)) this.disclosureState.delete(key)
        if ([...next].some(([key, node]) => this.nodes.get(key)?.hidden !== node.hidden)) this.layoutVersion++
        // DSH renders process groups as keyed seats. A partial history page can
        // prepend members into an existing group, so the seat cannot inherit
        // the identity of whichever tool currently happens to be first.
        const seats = new Map<string, string>()
        const originalKeys = [...next.keys()]
        const seatKey = (node: NativeNode) => node.process?.control
            ? `native-process:${node.process.key}`
            : node.group?.control ? `native-group:${node.group.key}` : node.key
        for (const key of originalKeys) {
            const node = next.get(key)!
            const seat = seatKey(node)
            if (seat === key) continue
            const previous = this.nodes.get(seat)
            next.set(seat, previous?.block === node.block && previous.hidden === node.hidden
                && previous.messageKey === key && sameDisclosure(previous.process, node.process)
                && sameDisclosure(previous.group, node.group) ? previous : { ...node, key: seat, messageKey: key })
            seats.set(key, seat)
        }
        const owners = new Map(seats)
        for (const key of originalKeys) {
            const node = next.get(key)!
            if (node.process && !node.process.open) owners.set(key, `native-process:${node.process.key}`)
            else if (node.group && !node.group.open) owners.set(key, `native-group:${node.group.key}`)
        }
        for (const [alias, key] of this.aliases) this.aliases.set(alias, owners.get(key) ?? key)
        for (const [key, owner] of owners) this.aliases.set(key, owner)
        this.nodes = next
        // A collapsed disclosure needs only its header, not assistant-ui
        // message/composer runtimes for each hidden tool. The full bounded
        // source remains available for execution, navigation and expansion.
        const runtimeBlocks = originalKeys.flatMap(key => {
            const node = next.get(key)!
            return !node.hidden && (!node.process || node.process.open) && (!node.group || node.group.open) ? [node.block] : []
        })
        if (runtimeBlocks.length !== this.runtimeBlocks.length
            || runtimeBlocks.some((block, index) => block !== this.runtimeBlocks[index])) this.runtimeBlocks = runtimeBlocks
        const order = originalKeys.map(key => seats.get(key) ?? key)
        if (order.length !== this.order.length || order.some((key, i) => this.order[i] !== key)) this.order = order
        if (blocks.length !== this.blocks.length || blocks.some((block, i) => this.blocks[i] !== block)) this.blocks = blocks
        for (const key of this.expanded.keys()) if (!turns.has(key)) this.expanded.delete(key)
    }
}

function isProcessMember(block: ChatBlock): boolean {
    if (block.kind === 'agent-reasoning') return true
    if (block.kind === 'agent-text') return executionOf(block)?.phase === 'commentary'
    if (block.kind !== 'tool-call') return false
    // HAPI business adaptation: rich results and unresolved interactions remain
    // reachable even when a completed process is collapsed.
    return block.tool.permission?.status !== 'pending'
        && block.tool.state !== 'pending' && block.tool.state !== 'running' && block.tool.state !== 'error'
        && !richToolParts(block.tool.result) && block.children.length === 0
        && !independentTool(block)
}

function independentTool(block: Extract<ChatBlock, { kind: 'tool-call' }>) {
    // Business controls and produced resources stay directly reachable.
    return isSubagentToolName(block.tool.name) || ['CodexAgent', 'spawn_agent', 'wait_agent', 'send_message',
        'followup_task', 'interrupt_agent', 'resume_agent', 'list_agents', 'ExitPlanMode', 'exit_plan_mode', 'update_plan',
        'TodoWrite', 'request_user_input', 'AskUserQuestion', 'CodexPermission'].includes(block.tool.name)
}

function isGroupMember(block: ChatBlock) {
    return block.kind === 'agent-reasoning' || (block.kind === 'tool-call'
        && !independentTool(block) && block.tool.permission?.status !== 'pending'
        && block.tool.state !== 'error' && !richToolParts(block.tool.result) && block.children.length === 0)
}

function sameDisclosure<T extends object>(left: T | undefined, right: T | undefined): boolean {
    return left === right || (left !== undefined && right !== undefined
        && (Object.keys(right) as Array<keyof T>).every(key => left[key] === right[key]))
}

export function nativeChatEnabled(native: boolean | undefined): boolean {
    return native === true && localStorage.getItem('hapi:native-chat-presentation') !== 'legacy'
}
