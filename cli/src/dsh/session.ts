import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { AcpConfigOptionDescriptor } from '@/agent/backends/acp/AcpSdkBackend'
import type { DshMode } from './types'

/** Remote-only HAPI session wrapper for a capability-negotiated DSH ACP server. */
export class DshSession extends AgentSessionBase<DshMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        messageQueue: MessageQueue2<DshMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
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
            sessionLabel: 'DshSession',
            sessionIdLabel: 'DeepSeek Harness ACP',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, dshSessionId: sessionId })
        })
        this.startedBy = opts.startedBy
    }

    publishSessionId(sessionId: string, resumable: boolean): void {
        if (resumable) {
            this.onSessionFound(sessionId)
        } else {
            this.sessionId = sessionId
            this.client.updateMetadata((metadata) => ({ ...metadata, dshSessionId: undefined }))
        }
    }

    publishConfigOptions(options: AcpConfigOptionDescriptor[]): void {
        this.client.updateMetadata((metadata) => ({ ...metadata, dshConfigOptions: options }))
        this.model = options.find((option) => option.category === 'model')?.currentValue ?? null
        const effort = options.find((option) => option.category === 'thought_level')?.currentValue
        this.effort = effort === undefined || effort === '' ? null : effort
        this.pushKeepAlive()
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
