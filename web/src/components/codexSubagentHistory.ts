import type { ApiClient } from '@/api/client'
import type { CodexSubagentMessagesResponse } from '@hapi/protocol/apiTypes'

type Page = CodexSubagentMessagesResponse
export type SubagentMessage = Page['messages'][number]
type State = { page: Page | null; loading: boolean; error: string | null; following: boolean; bounded: boolean; restarted: boolean }
const MESSAGE_LIMIT = 400
const CHARACTER_LIMIT = 2 * 1024 * 1024
const byteOffset = (message: SubagentMessage) => Number(message.id.slice(message.id.lastIndexOf(':') + 1))

/** One bounded read window per open native child. No root transcript mutations. */
export class CodexSubagentHistory {
    private state: State = { page: null, loading: false, error: null, following: true, bounded: false, restarted: false }
    private listeners = new Set<() => void>()
    private controller?: AbortController
    private active = false
    constructor(private api: ApiClient, private parentSessionId: string, readonly threadId: string, private auth: string | null) {}
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private patch(change: Partial<State>) { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()) }
    setActive(active: boolean) {
        this.active = active
        if (!active) { this.controller?.abort(); this.controller = undefined; if (this.state.loading) this.patch({ loading: false }) }
    }
    private current(controller: AbortController) { return this.active && this.controller === controller && !controller.signal.aborted && this.api.getAuthToken() === this.auth }
    refresh = () => this.state.following ? this.read('newer') : Promise.resolve()
    loadEarlier = () => this.read('older')
    loadLatest = () => this.read('latest')
    private merge(result: Page, mode: 'newer' | 'older' | 'latest') {
        const previous = this.state.page
        const reset = result.reset || (previous?.epoch && result.epoch && previous.epoch !== result.epoch)
        const replace = !previous || reset || mode === 'latest'
        const merged = new Map<string, SubagentMessage>()
        const input = replace ? result.messages : mode === 'older' ? [...result.messages, ...previous.messages] : [...previous.messages, ...result.messages]
        for (const message of input) if (!merged.has(message.id)) merged.set(message.id, message)
        const messages = [...merged.values()]
        let chars = messages.reduce((size, message) => size + JSON.stringify(message).length, 0)
        let bounded = this.state.bounded || result.truncated === true
        let headTrimmed = false
        while (messages.length > MESSAGE_LIMIT || (chars > CHARACTER_LIMIT && messages.length > 1)) {
            const dropped = mode === 'older' ? messages.pop()! : messages.shift()!
            if (mode !== 'older') headTrimmed = true
            chars -= JSON.stringify(dropped).length; bounded = true
        }
        const first = messages[0] ? byteOffset(messages[0]) : undefined
        const earlier = replace || mode === 'older' ? result : previous
        const trimmedBefore = headTrimmed && first !== undefined && Number.isSafeInteger(first) ? first : undefined
        const sameMessages = !replace && messages.length === previous.messages.length && messages.every((message, index) => message === previous.messages[index])
        const page: Page = { ...result, messages: sameMessages ? previous.messages : messages,
            before: trimmedBefore ?? earlier.before,
            hasMore: trimmedBefore !== undefined || earlier.hasMore,
            ...(mode === 'older' && !replace ? { after: previous.after } : {}),
        }
        this.patch({ page, bounded, restarted: this.state.restarted || Boolean(reset), following: mode !== 'older' })
    }
    private async read(mode: 'newer' | 'older' | 'latest') {
        if (!this.active || this.controller || this.api.getAuthToken() !== this.auth) return
        if (mode === 'older' && (!this.state.page?.hasMore || this.state.page.before === null)) return
        const controller = new AbortController()
        this.controller = controller
        this.patch({ loading: true, error: null })
        try {
            // A finite catch-up burst handles busy agents without starving UI.
            // Further committed records are read by the next visible refresh.
            for (let page = 0; page < 4; page++) {
                const current = this.state.page
                const options = mode === 'older' ? { before: current!.before!, epoch: current?.epoch }
                    : mode === 'newer' && current?.after !== undefined && current.epoch ? { after: current.after, epoch: current.epoch } : {}
                const result = await this.api.getCodexSubagentMessages(this.parentSessionId, this.threadId, { ...options, limit: 80, signal: controller.signal })
                if (!this.current(controller)) return
                if (result.threadId !== this.threadId) throw new Error('The response belongs to another subagent')
                this.merge(result, mode)
                if (mode !== 'newer' || !result.hasLater || result.after === current?.after) break
            }
        } catch (error) {
            if (this.current(controller)) this.patch({ error: error instanceof Error ? error.message : String(error) })
        } finally {
            if (this.controller === controller) { this.controller = undefined; this.patch({ loading: false }) }
        }
    }
}
