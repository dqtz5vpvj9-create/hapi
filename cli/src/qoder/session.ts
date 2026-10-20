import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { AcpConfigOptionDescriptor } from '@/agent/backends/acp/AcpSdkBackend'
import type { PermissionMode, QoderMode } from './types'

/** Remote-only HAPI session wrapper for a Qoder CN ACP server. */
export class QoderSession extends AgentSessionBase<QoderMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        messageQueue: MessageQueue2<QoderMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
        permissionMode?: PermissionMode
        model?: string
        effort?: string | null
        sessionId?: string | null
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId ?? null,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'remote',
            permissionMode: opts.permissionMode ?? 'default',
            model: opts.model,
            effort: opts.effort,
            sessionLabel: 'QoderSession',
            sessionIdLabel: 'Qoder CN ACP',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, qoderSessionId: sessionId })
        })
        this.startedBy = opts.startedBy
    }

    publishPermissionMode(mode: PermissionMode): void {
        this.permissionMode = mode
        this.pushKeepAlive()
    }

    publishModel(model: string | null): void {
        this.model = model
        this.pushKeepAlive()
    }

    publishEffort(effort: string | null): void {
        this.effort = effort
        this.pushKeepAlive()
    }

    publishSessionId(sessionId: string, resumable: boolean): void {
        if (resumable) {
            this.onSessionFound(sessionId)
        } else {
            this.sessionId = sessionId
            this.client.updateMetadata((metadata) => ({ ...metadata, qoderSessionId: undefined }))
        }
    }

    /**
     * Mirror the ACP session's config catalog (model, and thought level when the
     * agent advertises it) so the composer can offer model switching between
     * turns. Effort switching stays off for this flavor, so only the model is
     * reflected in the keepalive runtime.
     */
    publishConfigOptions(options: AcpConfigOptionDescriptor[]): void {
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            qoderConfigOptions: options.length > 0 ? options : undefined
        }))
        const model = options.find((option) => option.category === 'model')?.currentValue
        if (model !== undefined && model !== '') this.model = model
        this.pushKeepAlive()
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
