import React from 'react'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerHttp, PromptContent } from '@/agent/types'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { buildHapiMcpBridge, type HapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { createDshBackend } from './utils/dshBackend'
import type { DshSession } from './session'
import { DshSessionConfig, type DshConfigChange } from './dshSessionConfig'

export class DshRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    private abortInFlight: Promise<void> | null = null
    private launchInFlight: Promise<RemoteLauncherExitReason> | null = null
    private shutdownInFlight: Promise<void> | null = null
    private bridge: HapiMcpBridge | null = null
    private config: DshSessionConfig | null = null
    private activeSessionId: string | null = null
    private activationInFlight: Promise<void> | null = null

    constructor(private readonly session: DshSession, private readonly initialConfig: DshConfigChange = {}) {
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
            agentLabel: 'DeepSeek Harness'
        })
    }

    protected async runMainLoop(): Promise<void> {
        if (this.shouldExit) return
        const backend = createDshBackend()
        this.backend = backend
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => undefined
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
            await this.config?.settled()
            if (this.shouldExit || signal.aborted) continue

            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }]
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                if (this.shouldExit || this.abortInFlight) continue
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                this.session.sendSessionEvent({ type: 'message', message: `DSH prompt failed: ${message}` })
                this.messageBuffer.addMessage(`DSH prompt failed: ${message}`, 'status')
            } finally {
                this.session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit && !this.abortInFlight) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
            }
        }
    }

    private async activate(backend: ReturnType<typeof createDshBackend>): Promise<void> {
        await backend.initialize()
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
        if (this.shouldExit) return
        this.config = new DshSessionConfig(backend, this.session, acpSessionId)
        await this.config.apply(this.initialConfig)
        registerSessionConfigRpc({
            rpcHandlerManager: this.session.client.rpcHandlerManager,
            flavor: 'dsh',
            modelMode: 'nullable',
            effortMode: 'nullable',
            modelReasoningEffortMode: 'nullable',
            onApply: async (change) => {
                if (this.shouldExit || !this.config) throw new Error('DSH session is closing')
                await this.config.apply(change)
            }
        })
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

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
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status')
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
