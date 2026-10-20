import { formatDshError } from './dshErrors'
import React from 'react'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle'
import type { AgentMessage, McpServerHttp, PromptContent } from '@/agent/types'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { buildHapiMcpBridge, type HapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    InterruptDshSubagentRequestSchema,
    PromptDshSubagentRequestSchema,
    ReadDshSubagentMessagesRequestSchema
} from '@hapi/protocol/apiTypes'
import type {
    DshSubagentMessagesResponse,
    InterruptDshSubagentResponse,
    PromptDshSubagentResponse
} from '@hapi/protocol/apiTypes'
import type { DshSubagent } from '@hapi/protocol/schemas'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { createDshControl } from './utils/dshControl'
import type { DshControlSubagent } from './utils/dshControl'
import { createDshBackend, isOfficialDshAcpCommand, resolveDshAcpCommand } from './utils/dshBackend'
import { clearDshRestartRequired } from './bundles'
import type { DshSession } from './session'
import { DshSessionConfig, type DshConfigChange } from './dshSessionConfig'

export class DshRemoteLauncher extends RemoteLauncherBase {
    private control: Awaited<ReturnType<typeof createDshControl>> | null = null
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private abortInFlight: Promise<void> | null = null
    private launchInFlight: Promise<RemoteLauncherExitReason> | null = null
    private shutdownInFlight: Promise<void> | null = null
    private bridge: HapiMcpBridge | null = null
    private config: DshSessionConfig | null = null
    private activeSessionId: string | null = null
    /** localIds already drained into the turn that is running right now. */
    private readonly activeLocalIds = new Set<string>()
    private configUpdate: Promise<void> = Promise.resolve()
    private activationInFlight: Promise<void> | null = null
    private readonly syncNativeTitle: (title: unknown) => void
    private readonly nativeTitleTimers = new Set<ReturnType<typeof setTimeout>>()
    private static readonly NATIVE_TITLE_REFRESH_DELAYS_MS = [1000, 3000]
    /** DSH control channels; only the official runtime with the injected plugin has them. */
    private subagentTimer: ReturnType<typeof setInterval> | null = null
    private subagentRefresh: Promise<void> | null = null
    private subagentCatalogKey = ''
    private readonly subagentModes = new Map<string, DshSubagent['mode']>()
    private subagentRows: DshSubagent[] = []
    private static readonly SUBAGENT_REFRESH_MS = 3000

    constructor(private readonly session: DshSession, private readonly initialConfig: DshConfigChange = {}) {
        super(process.env.DEBUG ? session.logPath : undefined)
        // Metadata-only sink: the DSH native title must never become a chat row.
        this.syncNativeTitle = createNativeSessionTitleMetadataSync(session.client)
    }

    launch(): Promise<RemoteLauncherExitReason> {
        this.launchInFlight ??= this.start({ onExit: () => this.handleExitFromUi() })
        return this.launchInFlight
    }

    async kill(): Promise<void> {
        await this.requestExit('exit', async () => {
            this.abortController.abort()
            await this.shutdown()
        })
        await this.launchInFlight
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'DeepSeek Harness'
        })
    }

    protected async runMainLoop(): Promise<void> {
        if (this.shouldExit) return
        const resolved = resolveDshAcpCommand()
        if (isOfficialDshAcpCommand(resolved.command)) this.control = await createDshControl()
        const backend = createDshBackend({ ...process.env, ...this.control?.env }, this.session.getPermissionMode(), this.control?.patch)
        this.backend = backend
        // The official runtime has no ACP-native title update; its titles come
        // through the control plugin. Custom ACP servers keep the generic path.
        if (!this.control) {
            backend.setSessionInfoUpdateListener(({ title }) => this.syncNativeTitle(title))
        }
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            const failure = formatDshError(error, 'stderr')
            this.session.sendSessionEvent({ type: 'error', ...failure })
            this.messageBuffer.addMessage(failure.message, 'status')
        })
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode()
        )
        this.activationInFlight = this.activate(backend)
        await this.activationInFlight
        const acpSessionId = this.activeSessionId
        if (this.shouldExit || !acpSessionId) return

        while (!this.shouldExit) {
            await this.abortInFlight
            if (this.shouldExit) break
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }
            await this.configUpdate
            await this.config?.settled()
            if (this.shouldExit || signal.aborted) continue

            this.session.onThinkingChange(true)
            this.session.client.updateAgentState?.(state => ({ ...state, steeringActive: true }))
            this.activeLocalIds.clear()
            for (const item of batch.items) if (item.localId) this.activeLocalIds.add(item.localId)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message, ...(batch.items?.some(item => item.attachments?.length) ? { attachments: batch.items.flatMap(item => item.attachments ?? []) } : {}) }]
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                if (this.shouldExit || this.abortInFlight) continue
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                const failure = formatDshError(error)
                this.session.sendSessionEvent({ type: 'error', ...failure })
                this.messageBuffer.addMessage(failure.message, 'status')
            } finally {
                this.session.onThinkingChange(false)
                this.activeLocalIds.clear()
                this.session.client.updateAgentState?.(state => ({ ...state, steeringActive: false }))
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit && !this.abortInFlight) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
                // DSH appends the human message at turn start, so the native
                // title is readable even when the turn failed or was aborted.
                if (!this.shouldExit) {
                    this.scheduleNativeTitleRefresh(acpSessionId)
                    if (!this.control) void backend.refreshSessionInfo(acpSessionId, this.session.path)
                }
            }
        }
    }

    /**
     * Steering joins a queued message to the running turn through the ACP
     * `session/followup` extension. A failed admission restores the queue item
     * so the operator can send or cancel it from the composer.
     */
    private registerSteerHandler(backend: ReturnType<typeof createDshBackend>, acpSessionId: string): void {
        this.session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async (payload: unknown) => {
                const localId = typeof (payload as { localId?: unknown } | null)?.localId === 'string'
                    ? (payload as { localId: string }).localId
                    : ''
                if (!localId) return { steered: false, error: 'Missing localId' }
                if (!this.session.thinking || backend !== this.backend) {
                    return { steered: false, error: 'No active turn to steer' }
                }
                const taken = this.session.queue.takeByLocalId(localId)
                if (!taken) {
                    // The runner drained this row into the running turn between the
                    // hub's lookup and this call; that request is already satisfied.
                    if (this.activeLocalIds.has(localId)) return { steered: true }
                    return { steered: false, error: 'Message not in queue' }
                }
                const item = taken.item
                const prompt: PromptContent[] = [{
                    type: 'text',
                    text: item.message,
                    ...(item.attachments?.length ? { attachments: item.attachments } : {})
                }]
                if (!this.session.queue.beginReservationDispatch(taken)) {
                    return { steered: false, error: 'Steer cancelled' }
                }
                const dispatching = await this.session.client.setSteerDeliveryState([localId], 'dispatching')
                if (!dispatching) {
                    this.session.queue.markReservationIndeterminate(taken)
                    this.session.client.emitSteerIndeterminate([localId])
                    return { steered: false, error: 'Steer state is indeterminate' }
                }
                try {
                    const receipt = await backend.followup(acpSessionId, prompt)
                    if (!this.session.queue.commitReservation(taken)) {
                        this.session.client.emitSteerIndeterminate([localId])
                        return { steered: false, error: 'Steer state is indeterminate' }
                    }
                    logger.debug('[dsh-acp] steer accepted', { localId, messageId: receipt.messageId })
                    this.scheduleNativeTitleRefresh(acpSessionId)
                    this.messageBuffer.addMessage(item.message, 'user')
                    const acknowledged = await this.session.client.emitMessagesConsumedWithAck([localId], { steered: true })
                    if (!acknowledged) {
                        // The followup was accepted but the durable Hub ack was
                        // lost. Hold it as indeterminate rather than leaving the
                        // row in dispatching forever or replaying it blindly.
                        this.session.client.emitSteerIndeterminate([localId])
                        return { steered: false, error: 'Steer was accepted but could not be acknowledged' }
                    }
                    return { steered: true }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    // A transport timeout or broken pipe may have delivered the
                    // message before the response was lost. Hold the reservation
                    // for explicit retry/cancel instead of replaying it into the
                    // next turn.
                    if (isAcpIndeterminateError(error)) {
                        this.session.queue.markReservationIndeterminate(taken)
                        this.session.client.emitSteerIndeterminate([localId])
                        logger.warn('[dsh-acp] steer outcome is indeterminate', { message })
                        return { steered: false, error: 'Steer outcome is indeterminate' }
                    }
                    const restored = await this.session.client.setSteerDeliveryState([localId], 'queued')
                    if (!restored || !this.session.queue.restoreReservation(taken)) {
                        this.session.queue.markReservationIndeterminate(taken)
                        this.session.client.emitSteerIndeterminate([localId])
                        return { steered: false, error: 'Steer state is indeterminate' }
                    }
                    logger.warn('[dsh-acp] steer rejected', { message })
                    return { steered: false, error: message }
                }
            }
        )
    }

    private async activate(backend: ReturnType<typeof createDshBackend>): Promise<void> {
        await backend.initialize();
        this.session.client.updateMetadata?.(metadata => ({
            ...metadata,
            acpPromptCapabilities: { image: backend.supportsImageInput?.() === true }
        }))
        if (this.shouldExit) return

        const resumeId = this.session.sessionId
        if (resumeId && !backend.supportsResumeSession()) {
            throw new Error('This DSH ACP server does not advertise session/resume; the existing session was not replaced')
        }
        const mcpServers: McpServerHttp[] = []
        if (backend.supportsHttpMcp()) {
            this.bridge = await buildHapiMcpBridge(this.session.client, {
                skillLookup: { workingDirectory: this.session.path, flavor: 'dsh' }
            })
            mcpServers.push({ type: 'http', name: 'hapi', url: this.bridge.server.url, headers: [] })
        }
        if (this.shouldExit) return
        const sessionConfig = { cwd: this.session.path, mcpServers }
        const acpSessionId = resumeId
            ? await backend.resumeSession({ ...sessionConfig, sessionId: resumeId })
            : await backend.newSession(sessionConfig)
        this.activeSessionId = acpSessionId
        this.session.publishSessionId(acpSessionId, backend.supportsResumeSession())
        // A new DSH process has now composed the saved bundle list; the
        // restart banner can stop claiming a pending change.
        await clearDshRestartRequired().catch(() => {})
        if (this.shouldExit) return
        // Claim the root before any prompt: DSH child sessions inherit this
        // mode, so the control plugin must not write it to every session.
        if (this.control) {
            let claimError: unknown = null
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    await this.control.claimRoot(acpSessionId)
                    claimError = null
                    break
                } catch (error) {
                    claimError = error
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
            if (claimError) {
                const failure = formatDshError(claimError)
                this.session.sendSessionEvent({ type: 'error', ...failure })
                this.messageBuffer.addMessage(failure.message, 'status')
                // Native DSH persists sandbox modes. Continuing after a failed
                // root claim can resume a previously YOLO session while HAPI
                // reports the weaker default, so every mode fails closed.
                throw claimError
            }
        }
        if (this.shouldExit) return
        // Stamp capabilities only after the root claim has settled: a failed
        // claim may downgrade this.control and must not leave a stale "control"
        // or "steering" bit in the session metadata.
        this.session.client.updateMetadata?.(metadata => ({
            ...metadata,
            dshCapabilities: {
                control: this.control !== null,
                // Custom ACP servers can opt into the session/followup
                // extension explicitly; assuming it would surface a Steer
                // action that fails on every press.
                steering: this.control !== null || process.env.HAPI_DSH_ACP_FOLLOWUP === '1',
                resume: backend.supportsResumeSession(),
                images: backend.supportsImageInput?.() === true,
                // Custom ACP servers never get the injected control plugin, so
                // they cannot enumerate or read DSH child sessions.
                subagents: this.control !== null
            }
        }))
        this.registerSteerHandler(backend, acpSessionId)
        if (this.control) {
            this.registerSubagentRpcs(acpSessionId)
            this.startSubagentWatch(acpSessionId)
        }
        this.config = new DshSessionConfig(backend, this.session, acpSessionId)
        await this.config.apply(this.initialConfig)
        // Register the configuration RPC before the credential probe. If the
        // route selected at startup has no key, the session must stay alive so
        // the operator can switch models in place instead of losing the session
        // before the picker ever appears.
        registerSessionConfigRpc({
            rpcHandlerManager: this.session.client.rpcHandlerManager,
            flavor: 'dsh',
            modelMode: 'nullable',
            effortMode: 'nullable',
            modelReasoningEffortMode: 'nullable',
            onApply: (change) => {
                const update = this.configUpdate.then(async () => {
                    if (this.shouldExit || !this.config) throw new Error('DSH session is closing')
                    if (change.model !== undefined) {
                        const targetModel = this.config.resolveModel(change.model)
                        if (targetModel) await this.control?.preflight(targetModel)
                    }
                    if (change.permissionMode !== undefined) {
                        if (!this.control) throw new Error('This custom DSH ACP server does not expose live permission control')
                        if (!['default', 'read-only', 'yolo'].includes(change.permissionMode)) throw new Error('Invalid DSH permission mode')
                        await this.control.setPermission(acpSessionId, change.permissionMode)
                        this.session.publishPermissionMode(change.permissionMode as 'default' | 'read-only' | 'yolo')
                    }
                    await this.config.apply(change)
                })
                this.configUpdate = update.catch(() => {})
                return update
            }
        })
        try {
            const initialModel = this.config.resolveModel(this.initialConfig.model)
            if (initialModel) await this.control?.preflight(initialModel)
        } catch (error) {
            // Keep the session available for a model switch. The prompt itself
            // still fails closed if the route remains unconfigured.
            const failure = formatDshError(error)
            this.session.sendSessionEvent({ type: 'error', ...failure })
            this.messageBuffer.addMessage(failure.message, 'status')
        }
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })
        // Activation covers resumed sessions too: the first turn may be long
        // gone, but DSH still holds the durable title in the runtime.
        this.scheduleNativeTitleRefresh(acpSessionId)

    }

    /**
     * DSH generates the deterministic title when the first human message lands
     * and may replace it with a provider title later in the turn, so probe now
     * and again after the turn settles.
     */
    private scheduleNativeTitleRefresh(acpSessionId: string): void {
        if (!this.control) return
        void this.refreshNativeTitle(acpSessionId)
        for (const delay of DshRemoteLauncher.NATIVE_TITLE_REFRESH_DELAYS_MS) {
            const timer = setTimeout(() => {
                this.nativeTitleTimers.delete(timer)
                void this.refreshNativeTitle(acpSessionId)
            }, delay)
            timer.unref()
            this.nativeTitleTimers.add(timer)
        }
    }

    private async refreshNativeTitle(acpSessionId: string): Promise<void> {
        if (!this.control || this.shouldExit) return
        try {
            this.syncNativeTitle(await this.control.getTitle(acpSessionId))
        } catch (error) {
            // A session-list label is not worth failing a turn over.
            logger.debug('[dsh-acp] native session title unavailable', { error: String(error) })
        }
    }

    private clearNativeTitleTimers(): void {
        for (const timer of this.nativeTitleTimers) clearTimeout(timer)
        this.nativeTitleTimers.clear()
    }

    /**
     * Expose the DSH child catalog and transcripts through this session's RPC
     * channel. Every address is re-checked against the durable catalog of the
     * root session this process launched, so a client cannot reach a session
     * owned by another DSH root.
     */
    private registerSubagentRpcs(acpSessionId: string): void {
        const rpc = this.session.client.rpcHandlerManager
        rpc.registerHandler(RPC_METHODS.ReadDshSubagentMessages, async (raw: unknown): Promise<DshSubagentMessagesResponse> => {
            const parsed = ReadDshSubagentMessagesRequestSchema.safeParse(raw)
            if (!parsed.success) throw new Error('Invalid DSH subagent transcript request')
            const control = this.control
            if (!control) throw new Error('This DSH runtime does not expose live subagent control')
            const { sessionId, limit, before, after, epoch } = parsed.data
            const mode = await this.ensureSubagentCatalog(acpSessionId, sessionId)
            // External providers keep no local child session; their durable record
            // is the parent-side delegation call plus the settlement message.
            const page = mode === 'external'
                ? await control.externalRecord(acpSessionId, sessionId)
                : await control.transcript(sessionId, { limit, before, after, epoch })
            if (page.sessionId !== sessionId) throw new Error('The response belongs to another subagent')
            return {
                sessionId: page.sessionId,
                messages: page.messages,
                before: page.before,
                hasMore: page.hasMore,
                after: page.after,
                epoch: page.epoch,
                hasLater: page.hasLater,
                reset: page.reset,
                truncated: page.truncated
            }
        })
        rpc.registerHandler(RPC_METHODS.PromptDshSubagent, async (raw: unknown): Promise<PromptDshSubagentResponse> => {
            const parsed = PromptDshSubagentRequestSchema.safeParse(raw)
            if (!parsed.success) throw new Error('Invalid DSH subagent prompt request')
            const control = this.control
            if (!control) throw new Error('This DSH runtime does not expose live subagent control')
            const { sessionId, text, delivery, requestId } = parsed.data
            this.requireContinuableSubagent(await this.ensureSubagentCatalog(acpSessionId, sessionId), sessionId)
            const receipt = await control.prompt(acpSessionId, sessionId, text, { delivery, requestId })
            void this.refreshSubagents(acpSessionId)
            return receipt.messageId ? { messageId: receipt.messageId } : {}
        })
        rpc.registerHandler(RPC_METHODS.InterruptDshSubagent, async (raw: unknown): Promise<InterruptDshSubagentResponse> => {
            const parsed = InterruptDshSubagentRequestSchema.safeParse(raw)
            if (!parsed.success) throw new Error('Invalid DSH subagent interrupt request')
            const control = this.control
            if (!control) throw new Error('This DSH runtime does not expose live subagent control')
            this.requireContinuableSubagent(await this.ensureSubagentCatalog(acpSessionId, parsed.data.sessionId), parsed.data.sessionId)
            const receipt = await control.interrupt(acpSessionId, parsed.data.sessionId)
            void this.refreshSubagents(acpSessionId)
            return receipt
        })
    }

    /** Resolve one addressed child against this root's durable catalog; a cold view refreshes once. */
    private async ensureSubagentCatalog(acpSessionId: string, sessionId: string): Promise<DshSubagent['mode']> {
        let mode = this.subagentModes.get(sessionId)
        if (mode === undefined) {
            await this.refreshSubagents(acpSessionId)
            mode = this.subagentModes.get(sessionId)
        }
        if (mode === undefined) throw new Error('Subagent is not a direct child of this session')
        return mode
    }

    private requireContinuableSubagent(mode: DshSubagent['mode'], sessionId: string): void {
        if (mode !== 'continuable') throw new Error(`DSH subagent ${sessionId} is read-only (${mode})`)
    }

    private startSubagentWatch(acpSessionId: string): void {
        if (this.subagentTimer) return
        void this.refreshSubagents(acpSessionId)
        const timer = setInterval(() => { void this.refreshSubagents(acpSessionId) }, DshRemoteLauncher.SUBAGENT_REFRESH_MS)
        timer.unref()
        this.subagentTimer = timer
    }

    private stopSubagentWatch(): void {
        if (this.subagentTimer) clearInterval(this.subagentTimer)
        this.subagentTimer = null
        this.subagentRefresh = null
    }

    private async refreshSubagents(acpSessionId: string): Promise<void> {
        if (this.shouldExit) return
        if (this.subagentRefresh) return await this.subagentRefresh
        const control = this.control
        if (!control) return
        this.subagentRefresh = (async () => {
            try {
                this.publishSubagents(await control.subagents(acpSessionId))
            } catch (error) {
                // The catalog is metadata; a control hiccup must not fail the turn.
                logger.debug('[dsh-acp] subagent catalog unavailable', { error: String(error) })
            } finally {
                this.subagentRefresh = null
            }
        })()
        await this.subagentRefresh
    }

    private publishSubagents(children: DshControlSubagent[]): void {
        const next = children.map(normalizeDshSubagent)
            .filter((child): child is DshSubagent => child !== null)
            .sort((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId))
        this.subagentModes.clear()
        this.subagentRows = next
        for (const child of next) this.subagentModes.set(child.sessionId, child.mode)
        const key = JSON.stringify(next)
        if (key === this.subagentCatalogKey) return
        this.subagentCatalogKey = key
        this.session.client.updateMetadata?.(metadata => ({
            ...metadata,
            // An empty catalog clears the field so a finished team stops
            // advertising rows that no longer exist.
            dshSubagents: next.length > 0 ? next : undefined
        }))
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async () => {
            throw new Error('DSH session is closed')
        })
        await this.shutdown()
    }

    private shutdown(): Promise<void> {
        this.shutdownInFlight ??= (async () => {
            this.clearNativeTitleTimers()
            this.stopSubagentWatch()
            await this.activationInFlight?.catch(() => {})
            this.config?.dispose()
            await this.permissionHandler?.cancelAll('Session ended')
            const backend = this.backend
            try {
                if (backend && this.activeSessionId) {
                    if (backend.supportsCloseSession()) {
                        await backend.closeSession(this.activeSessionId)
                    } else {
                        await backend.cancelPrompt(this.activeSessionId)
                    }
                }
            } catch (error) {
                logger.warn('[dsh-acp] session shutdown failed', { error: String(error) })
            } finally {
                try {
                    await backend?.disconnect()
                } finally {
                    await this.control?.dispose()
                    this.control = null
                    this.bridge?.server.stop()
                    this.bridge = null
                    this.backend = null
                    this.permissionHandler = null
                    this.session.onThinkingChange(false)
                }
            }
        })()
        return this.shutdownInFlight
    }

    private handleAgentMessage(message: AgentMessage): void {
        if (message.type === 'error') {
            const failure = formatDshError(message.message)
            this.session.sendSessionEvent({ type: 'error', ...failure })
            this.messageBuffer.addMessage(failure.message, 'status')
            return
        }
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                // A teammate spawned during the turn is already durable when it
                // settles; reflect it before the next poll tick.
                if (this.control && this.activeSessionId) void this.refreshSubagents(this.activeSessionId)
                break
            case 'usage':
            case 'reasoning':
            case 'tool_call':
            case 'tool_result':
            case 'plan':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    private handleAbort(): Promise<void> {
        if (this.abortInFlight) return this.abortInFlight
        this.session.queue.reset()
        this.abortController.abort()
        this.abortInFlight = (async () => {
            try {
                if (this.backend && this.activeSessionId) {
                    await this.backend.cancelPrompt(this.activeSessionId)
                }
                await this.permissionHandler?.cancelAll('User aborted')
                let timeout: ReturnType<typeof setTimeout> | undefined
                try {
                    await Promise.race([
                        this.backend?.waitForResponseComplete(),
                        new Promise<never>((_, reject) => {
                            timeout = setTimeout(() => reject(new Error('DSH did not finish cancelling within 10 seconds')), 10_000)
                        })
                    ])
                } finally {
                    if (timeout) clearTimeout(timeout)
                }
                this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
                this.messageBuffer.addMessage('Turn aborted', 'status')
            } catch (error) {
                this.shouldExit = true
                this.exitReason = 'exit'
                await this.shutdown()
                throw error
            } finally {
                this.session.onThinkingChange(false)
                if (!this.shouldExit) {
                    this.abortController = new AbortController()
                    if (this.session.queue.size() === 0) this.session.sendSessionEvent({ type: 'ready' })
                }
                this.abortInFlight = null
            }
        })()
        return this.abortInFlight
    }

    private async handleExitFromUi(): Promise<void> {
        await this.kill()
    }
}

const DSH_SUBAGENT_MODES = new Set<DshSubagent['mode']>(['one-shot', 'continuable', 'external', 'unknown'])

/** Accept only the catalog fields HAPI mirrors; a malformed row is dropped. */
function normalizeDshSubagent(child: DshControlSubagent): DshSubagent | null {
    if (!child || typeof child.sessionId !== 'string' || child.sessionId === '') return null
    const row: DshSubagent = {
        sessionId: child.sessionId,
        mode: DSH_SUBAGENT_MODES.has(child.mode) ? child.mode : 'unknown',
        activity: child.activity === 'running' ? 'running' : 'inactive',
        createdAt: typeof child.createdAt === 'number' ? child.createdAt : 0
    }
    if (typeof child.label === 'string' && child.label !== '') row.label = child.label
    if (typeof child.name === 'string' && child.name !== '') row.name = child.name
    if (typeof child.provider === 'string' && child.provider !== '') row.provider = child.provider
    if (child.teamStatus === 'running' || child.teamStatus === 'inactive' || child.teamStatus === 'provisioning' || child.teamStatus === 'failed') {
        row.teamStatus = child.teamStatus
    }
    if (typeof child.settledMs === 'number' && Number.isFinite(child.settledMs) && child.settledMs >= 0) row.settledMs = child.settledMs
    if (typeof child.openSince === 'number' && Number.isFinite(child.openSince) && child.openSince >= 0) row.openSince = child.openSince
    if (typeof child.lastTurnCompleted === 'boolean') row.lastTurnCompleted = child.lastTurnCompleted
    return row
}
