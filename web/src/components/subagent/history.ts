import type {
    NativeSubagentRef,
    SubagentCursorOf,
    SubagentHistoryState,
    SubagentMessage,
    SubagentPage,
    SubagentSource,
} from './types'

/** Retained window limits shared with the Codex-only reader. */
export const SUBAGENT_MESSAGE_LIMIT = 400
export const SUBAGENT_CHARACTER_LIMIT = 2 * 1024 * 1024
/** Cadence used by subagent views to poll a followed child. */
export const SUBAGENT_FOLLOW_INTERVAL_MS = 2000
/** Messages requested per read; the bounded window holds several pages. */
const PAGE_SIZE = 80
/** A finite catch-up burst handles busy children without starving the UI. */
const CATCH_UP_PAGES = 4

/**
 * Transcript rows carry their pagination cursor as the number after the final
 * `:`. For Codex that number is the append byte offset; for DSH it is the
 * transcript position (the message's ordinal in the child log). Both are used
 * identically: "the first message older than this cursor".
 */
function trailingNumberCursor(message: SubagentMessage): number | undefined {
    const separator = message.id.lastIndexOf(':')
    if (separator < 0) return undefined
    const value = Number(message.id.slice(separator + 1))
    return Number.isSafeInteger(value) ? value : undefined
}

export const codexMessageCursor: SubagentCursorOf = trailingNumberCursor

export const dshMessageCursor: SubagentCursorOf = trailingNumberCursor

export function cursorOfFor(ref: Pick<NativeSubagentRef, 'flavor'>): SubagentCursorOf {
    return ref.flavor === 'dsh' ? dshMessageCursor : codexMessageCursor
}

/** One bounded read window per open native child. No root transcript mutations. */
export class SubagentHistory {
    private state: SubagentHistoryState = {
        page: null,
        loading: false,
        error: null,
        following: true,
        bounded: false,
        restarted: false,
    }
    private listeners = new Set<() => void>()
    private controller?: AbortController
    private active = false
    constructor(
        private source: SubagentSource,
        private cursorOf: SubagentCursorOf = cursorOfFor(source.ref),
    ) {}
    get = () => this.state
    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    private patch(change: Partial<SubagentHistoryState>) {
        this.state = { ...this.state, ...change }
        this.listeners.forEach(listener => listener())
    }
    setActive(active: boolean) {
        this.active = active
        if (!active) {
            this.controller?.abort()
            this.controller = undefined
            if (this.state.loading) this.patch({ loading: false })
        }
    }
    private currentIdentity() { return this.source.isCurrent?.() ?? true }
    private current(controller: AbortController) {
        return this.active && this.controller === controller && !controller.signal.aborted && this.currentIdentity()
    }
    refresh = () => this.state.following ? this.read('newer') : Promise.resolve()
    loadEarlier = () => this.read('older')
    loadLatest = () => this.read('latest')
    private merge(result: SubagentPage, mode: 'newer' | 'older' | 'latest') {
        const previous = this.state.page
        const reset = Boolean(result.reset) || Boolean(previous?.epoch && result.epoch && previous.epoch !== result.epoch)
        const replace = !previous || reset || mode === 'latest'
        const merged = new Map<string, SubagentMessage>()
        const input = replace
            ? result.messages
            : mode === 'older'
                ? [...result.messages, ...previous!.messages]
                : [...previous!.messages, ...result.messages]
        for (const message of input) if (!merged.has(message.id)) merged.set(message.id, message)
        const messages = [...merged.values()]
        let chars = messages.reduce((size, message) => size + JSON.stringify(message).length, 0)
        let bounded = this.state.bounded || result.truncated === true
        let headTrimmed = false
        while (messages.length > SUBAGENT_MESSAGE_LIMIT || (chars > SUBAGENT_CHARACTER_LIMIT && messages.length > 1)) {
            const dropped = mode === 'older' ? messages.pop()! : messages.shift()!
            if (mode !== 'older') headTrimmed = true
            chars -= JSON.stringify(dropped).length
            bounded = true
        }
        const first = messages[0] ? this.cursorOf(messages[0]) : undefined
        const earlier = replace || mode === 'older' || !previous ? result : previous
        const trimmedBefore = headTrimmed && first !== undefined ? first : undefined
        const sameMessages = Boolean(previous)
            && !replace
            && messages.length === previous!.messages.length
            && messages.every((message, index) => message === previous!.messages[index])
        const page: SubagentPage = {
            ...result,
            messages: sameMessages && previous ? previous.messages : messages,
            before: trimmedBefore ?? earlier.before,
            hasMore: trimmedBefore !== undefined || earlier.hasMore,
            ...(mode === 'older' && !replace && previous ? { after: previous.after } : {}),
        }
        this.patch({
            page,
            bounded,
            restarted: this.state.restarted || reset,
            following: mode !== 'older',
        })
    }
    private async read(mode: 'newer' | 'older' | 'latest') {
        if (!this.active || this.controller || !this.currentIdentity()) return
        if (mode === 'older' && (!this.state.page?.hasMore || this.state.page.before === null)) return
        const controller = new AbortController()
        this.controller = controller
        this.patch({ loading: true, error: null })
        try {
            // A finite catch-up burst handles busy children without starving the UI.
            // Further committed records are read by the next visible refresh.
            for (let page = 0; page < CATCH_UP_PAGES; page++) {
                const current = this.state.page
                const options = mode === 'older'
                    ? { before: current!.before!, epoch: current?.epoch }
                    : mode === 'newer' && current?.after !== undefined && current.epoch
                        ? { after: current.after, epoch: current.epoch }
                        : {}
                const result = await this.source.read({ ...options, limit: PAGE_SIZE, signal: controller.signal })
                if (!this.current(controller)) return
                this.merge(result, mode)
                if (mode !== 'newer' || !result.hasLater || result.after === current?.after) break
            }
        } catch (error) {
            if (this.current(controller)) this.patch({ error: error instanceof Error ? error.message : String(error) })
        } finally {
            if (this.controller === controller) {
                this.controller = undefined
                this.patch({ loading: false })
            }
        }
    }
}

/** Convenience constructor; picks the cursor implementation from the source's flavor. */
export function createSubagentHistory(source: SubagentSource): SubagentHistory {
    return new SubagentHistory(source)
}
