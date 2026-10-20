import React from 'react'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import type { AgentMessage, McpServerHttp, PromptContent } from '@/agent/types'
import type { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import { buildHapiMcpBridge, type HapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import {
    createQoderBackend,
    configOptionsWithModels,
    defaultQoderModel,
    formatQoderError,
    qoderEffortOption,
    resolveQoderEffortValue,
    resolveQoderPermissionModeId
} from './utils/qoderBackend'
import type { QoderSession } from './session'
import type { PermissionMode } from './types'

/**
 * Remote-only launcher for the Qoder CN ACP server. It has no local PTY mode:
 * the HAPI session always starts in `remote` and exposes no local switch.
 */
export class QoderRemoteLauncher extends RemoteLauncherBase {
    private backend: AcpSdkBackend | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private bridge: HapiMcpBridge | null = null
    private abortController = new AbortController()
    private abortInFlight: Promise<void> | null = null
    private launchInFlight: Promise<RemoteLauncherExitReason> | null = null
    private shutdownInFlight: Promise<void> | null = null
    private activationInFlight: Promise<void> | null = null
    private configUpdate: Promise<void> = Promise.resolve()
    private activeSessionId: string | null = null
    private currentBackendModel: string | null = null
    private currentBackendEffort: string | null = null
    private defaultBackendEffort: string | null = null
    private appliedPermissionMode: PermissionMode | null = null
    private permissionSwitchUnavailable = false

    constructor(private readonly session: QoderSession) {
        super(process.env.DEBUG ? session.logPath : undefined)
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
            agentLabel: 'Qoder CN'
        })
    }

    protected async runMainLoop(): Promise<void> {
        if (this.shouldExit) return
        const session = this.session
        const backend = createQoderBackend()
        this.backend = backend
        registerAcpSessionTitleSync(backend, session.client)
        backend.onStderrError((error) => {
            logger.debug('[qoder-acp] stderr error', error)
            const failure = formatQoderError(error, 'stderr')
            session.sendSessionEvent({ type: 'error', ...failure })
            this.messageBuffer.addMessage(failure.message, 'status')
        })
        this.permissionHandler = new AcpPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode()
        )
        this.activationInFlight = this.activate(backend)
        await this.activationInFlight
        const acpSessionId = this.activeSessionId
        if (this.shouldExit || !acpSessionId) return

        const sendReady = () => {
            if (!this.shouldExit) session.sendSessionEvent({ type: 'ready' })
        }

        while (!this.shouldExit) {
            await this.abortInFlight
            if (this.shouldExit) break
            const signal = this.abortController.signal
            const batch = await session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }
            await this.configUpdate
            if (this.shouldExit || signal.aborted) continue
            // Model switches land on a turn boundary: the ACP backend waits for
            // any in-flight prompt to drain before applying session/set_model.
            await this.applyPendingModel(acpSessionId)
            if (this.shouldExit || signal.aborted) continue
            await this.applyPendingEffort(acpSessionId)
            if (this.shouldExit || signal.aborted) continue

            session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{
                type: 'text',
                text: batch.message,
                ...(batch.items?.some(item => item.attachments?.length)
                    ? { attachments: batch.items.flatMap(item => item.attachments ?? []) }
                    : {})
            }]
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
                if (!this.shouldExit) void backend.refreshSessionInfo(acpSessionId, session.path)
            } catch (error) {
                if (this.shouldExit || this.abortInFlight) continue
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[qoder-acp] prompt failed', { message })
                const failure = formatQoderError(error)
                session.sendSessionEvent({ type: 'error', ...failure })
                this.messageBuffer.addMessage(failure.message, 'status')
            } finally {
                session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (session.queue.size() === 0 && !this.shouldExit) sendReady()
            }
        }
    }

    private async activate(backend: AcpSdkBackend): Promise<void> {
        await backend.initialize()
        this.session.client.updateMetadata?.(metadata => ({
            ...metadata,
            acpPromptCapabilities: { image: backend.supportsImageInput?.() === true }
        }))
        if (this.shouldExit) return

        const resumeId = this.session.sessionId
        if (resumeId && !backend.supportsResumeSession()) {
            throw new Error(
                'This Qoder CN ACP server does not advertise session/resume; the existing session was not replaced'
            )
        }
        const mcpServers: McpServerHttp[] = []
        if (backend.supportsHttpMcp()) {
            this.bridge = await buildHapiMcpBridge(this.session.client, {
                skillLookup: { workingDirectory: this.session.path, flavor: 'qoder' }
            })
            mcpServers.push({ type: 'http', name: 'hapi', url: this.bridge.server.url, headers: [] })
        }
        if (this.shouldExit) return

        const sessionConfig = { cwd: this.session.path, mcpServers }
        // Not signed in is the expected failure on a fresh host. The raw ACP
        // rejection propagates to runQoder, whose error formatter turns it into
        // the one-time login command; nothing opens a browser here.
        const acpSessionId = resumeId
            ? await backend.resumeSession({ ...sessionConfig, sessionId: resumeId })
            : await backend.newSession(sessionConfig)
        this.activeSessionId = acpSessionId
        this.session.publishSessionId(acpSessionId, backend.supportsResumeSession())

        backend.setSessionConfigOptionsListener((id) => {
            if (id === acpSessionId) this.publishConfigOptions()
        })
        this.currentBackendModel = backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
            ?? backend.getConfigOptionByCategory(acpSessionId, 'model')?.currentValue
            ?? null
        this.publishConfigOptions()

        const requestedModel = this.session.getModel() ?? null
        if (requestedModel) {
            if (requestedModel !== this.currentBackendModel) {
                try {
                    await this.applyModel(acpSessionId, requestedModel)
                } catch (error) {
                    const failure = formatQoderError(error)
                    logger.warn('[qoder-acp] initial model switch failed', { message: failure.message })
                    this.session.sendSessionEvent({ type: 'error', ...failure })
                    this.messageBuffer.addMessage(failure.message, 'status')
                    this.session.publishModel(this.currentBackendModel)
                }
            }
        } else {
            const models = backend.getSessionModelsMetadata(acpSessionId)?.availableModels ?? []
            const preferred = defaultQoderModel(models, this.currentBackendModel)
            if (preferred && preferred !== this.currentBackendModel) {
                try {
                    await this.applyModel(acpSessionId, preferred)
                } catch (error) {
                    const failure = formatQoderError(error)
                    logger.warn('[qoder-acp] default model switch failed', { message: failure.message })
                    this.session.sendSessionEvent({ type: 'error', ...failure })
                    this.messageBuffer.addMessage(failure.message, 'status')
                }
            }
            if (this.currentBackendModel) this.session.publishModel(this.currentBackendModel)
        }

        const effortOption = qoderEffortOption(backend.getSessionConfigOptions(acpSessionId))
        this.currentBackendEffort = effortOption?.currentValue ?? null
        this.defaultBackendEffort = this.currentBackendEffort
        this.session.publishEffort(this.currentBackendEffort)
        const requestedEffort = this.session.getEffort()
        if (requestedEffort !== undefined && requestedEffort !== null && requestedEffort !== this.currentBackendEffort) {
            try {
                await this.applyEffort(acpSessionId, requestedEffort)
            } catch (error) {
                const failure = formatQoderError(error)
                logger.warn('[qoder-acp] initial effort switch failed', { message: failure.message })
                this.session.sendSessionEvent({ type: 'error', ...failure })
                this.session.publishEffort(this.currentBackendEffort)
            }
        }

        const permissionMode = (this.session.getPermissionMode() ?? 'default') as PermissionMode
        await this.applyInitialPermissionMode(acpSessionId, permissionMode)
        if (this.shouldExit) return

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            // Remote-only flavor: a web-initiated switch to local has no target
            // mode, so ignore it instead of aborting the session.
            onSwitch: () => {}
        })
        this.registerConfigRpc()
    }

    private registerConfigRpc(): void {
        registerSessionConfigRpc<PermissionMode>({
            rpcHandlerManager: this.session.client.rpcHandlerManager,
            flavor: 'qoder',
            modelMode: 'nullable',
            modelReasoningEffortMode: 'ignore',
            effortMode: 'nullable',
            onApply: async (change) => {
                const update = this.configUpdate.then(async () => {
                    if (this.shouldExit) throw new Error('Qoder CN session is closing')
                    if (change.permissionMode !== undefined) {
                        const mode = change.permissionMode
                        if (this.backend && this.activeSessionId) {
                            await this.applyPermissionMode(this.activeSessionId, mode)
                            this.appliedPermissionMode = mode
                        }
                        this.session.publishPermissionMode(mode)
                    }
                    if (change.model !== undefined) {
                        // ACP session-config changes only take effect between
                        // turns; the queued turn applies this before prompting.
                        this.session.publishModel(change.model)
                    }
                    if (change.effort !== undefined) {
                        // Published optimistically; the turn loop applies it and
                        // rolls the published value back on failure.
                        this.session.publishEffort(change.effort)
                    }
                })
                this.configUpdate = update.catch(() => {})
                return update
            },
            appliedFallback: () => ({ permissionMode: this.session.getPermissionMode() })
        })
    }

    private async applyInitialPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        try {
            await this.applyPermissionMode(sessionId, mode)
            this.appliedPermissionMode = mode
        } catch (error) {
            // Startup must survive a CLI build without session mode switching;
            // the turn loop falls back to the agent default and keeps working.
            this.permissionSwitchUnavailable = true
            this.appliedPermissionMode = mode
            logger.warn('[qoder-acp] unable to apply permission mode', error)
            this.session.sendSessionEvent({
                type: 'message',
                message: `This Qoder CN build does not accept live permission mode switching; the session keeps the agent default mode.`
            })
        }
    }

    /**
     * Prefer ACP `session/set_mode` with the translated id. Some builds only
     * expose the `mode` config option, so fall back to it when the backend
     * advertises the mapped value.
     */
    private async applyPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        const backend = this.backend
        if (!backend) throw new Error('Qoder CN is not ready')
        if (this.permissionSwitchUnavailable) throw new Error('This Qoder CN build does not support live permission switching')
        const modeOption = backend.getConfigOptionByCategory(sessionId, 'mode')
        const modeId = resolveQoderPermissionModeId(mode, modeOption?.options.map((entry) => entry.value))
        try {
            await backend.setMode(sessionId, modeId)
            return
        } catch (error) {
            const option = backend.getConfigOptionByCategory(sessionId, 'mode')
            if (!option || !option.options.some((entry) => entry.value === modeId)) throw error
            logger.debug('[qoder-acp] falling back to the mode config option', { modeId })
            await backend.setConfigOption(sessionId, option.id, modeId)
        }
    }

    private async applyModel(sessionId: string, model: string): Promise<void> {
        const backend = this.backend
        if (!backend) throw new Error('Qoder CN is not ready')
        await backend.setModel(sessionId, model, { flavor: 'qoder' })
        this.currentBackendModel = model
        this.session.publishModel(model)
        this.publishConfigOptions()
        // The new model may advertise a different effort set; resync to the
        // server's value so a stale level is never sent on the next turn.
        const effort = qoderEffortOption(backend.getSessionConfigOptions(sessionId))?.currentValue
        if (effort !== undefined) {
            this.currentBackendEffort = effort
            this.session.publishEffort(effort)
        }
    }

    private async applyEffort(sessionId: string, effort: string | null): Promise<void> {
        const backend = this.backend
        if (!backend) throw new Error('Qoder CN is not ready')
        const option = qoderEffortOption(backend.getSessionConfigOptions(sessionId))
        const value = resolveQoderEffortValue(effort, option, this.defaultBackendEffort)
        if (value === null) throw new Error('Qoder CN did not advertise any reasoning effort level')
        if (option && option.currentValue !== value) {
            await backend.setConfigOption(sessionId, option.id, value, { waitForResponse: false })
        }
        this.currentBackendEffort = value
        this.session.publishEffort(value)
    }

    private async applyPendingEffort(sessionId: string): Promise<void> {
        const requested = this.session.getEffort()
        if (requested === undefined || requested === this.currentBackendEffort) return
        try {
            await this.applyEffort(sessionId, requested)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[qoder-acp] effort switch failed', { message })
            const current = this.backend
                ? qoderEffortOption(this.backend.getSessionConfigOptions(sessionId))?.currentValue
                : undefined
            if (current !== undefined) this.currentBackendEffort = current
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch the Qoder CN reasoning effort. Continuing with ${this.currentBackendEffort ?? 'the agent default'}.`
            })
            this.session.publishEffort(this.currentBackendEffort)
        }
    }

    private async applyPendingModel(sessionId: string): Promise<void> {
        const requested = this.session.getModel() ?? null
        if (!requested || requested === this.currentBackendModel) return
        try {
            await this.applyModel(sessionId, requested)
        } catch (error) {
            const failure = formatQoderError(error)
            logger.warn('[qoder-acp] model switch failed', { message: failure.message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch the Qoder CN model to ${requested}. Continuing with ${this.currentBackendModel ?? 'the agent default'}.`
            })
            this.session.publishModel(this.currentBackendModel)
        }
    }

    private publishConfigOptions(): void {
        const sessionId = this.activeSessionId
        if (!this.backend || !sessionId) return
        this.session.publishConfigOptions(configOptionsWithModels(
            this.backend.getSessionConfigOptions(sessionId) ?? [],
            this.backend.getSessionModelsMetadata(sessionId)
        ))
    }

    private handleAgentMessage(message: AgentMessage): void {
        if (message.type === 'error') {
            const failure = formatQoderError(message.message)
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
            case 'reasoning':
                if (!message.live) {
                    this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system')
                }
                break
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool')
                break
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result')
                break
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
                break
            case 'usage':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.shutdown()
    }

    private shutdown(): Promise<void> {
        this.shutdownInFlight ??= (async () => {
            this.backend?.setSessionConfigOptionsListener(null)
            await this.activationInFlight?.catch(() => {})
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
                logger.warn('[qoder-acp] session shutdown failed', { error: String(error) })
            } finally {
                try {
                    await backend?.disconnect()
                } finally {
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
                            timeout = setTimeout(
                                () => reject(new Error('Qoder CN did not finish cancelling within 10 seconds')),
                                10_000
                            )
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

export async function qoderRemoteLauncher(session: QoderSession): Promise<RemoteLauncherExitReason> {
    return new QoderRemoteLauncher(session).launch()
}
