import { formatQoderError } from './utils/qoderBackend'
import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { AgentState } from '@/api/types'
import { QoderRemoteLauncher } from './qoderRemoteLauncher'
import { QoderSession } from './session'
import type { PermissionMode, QoderMode } from './types'

export async function runQoder(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    workingDirectory?: string
    resumeSessionId?: string
    permissionMode?: PermissionMode
    model?: string
    effort?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    // Qoder CN has no local PTY mode: every HAPI session starts remote.
    const startingMode = 'remote' as const
    const initialState: AgentState = {
        controlledByUser: false,
        startingMode
    }

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'qoder',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'qoder',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: opts.model,
            reservedSessionId: opts.reservedSessionId
        })
    const { api, session } = bootstrap
    setControlledByUser(session, startingMode)

    const queue = new MessageQueue2<QoderMode>((mode) => hashObject(mode))
    const sessionRef: { current: QoderSession | null } = { current: null }
    const launcherRef: { current: QoderRemoteLauncher | null } = { current: null }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            'qoder',
            localId,
            message.content.attachments
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'qoder',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)

    const qoderSession = new QoderSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        messageQueue: queue,
        onModeChange: () => {},
        startedBy,
        permissionMode: opts.permissionMode,
        model: opts.model,
        effort: opts.effort,
        sessionId: opts.resumeSessionId ?? session.getMetadata()?.qoderSessionId ?? null
    })
    const launcher = new QoderRemoteLauncher(qoderSession)
    sessionRef.current = qoderSession
    launcherRef.current = launcher

    let crashed = false
    try {
        await launcher.launch()
    } catch (error) {
        crashed = true
        session.sendSessionEvent({ type: 'error', ...formatQoderError(error, 'activation') })
        lifecycle.markCrash(error)
    } finally {
        if (!crashed) lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanupAndExit()
    }
}
