import { formatDshError } from './dshErrors'
import { hashObject } from '@/utils/deterministicJson'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { logger } from '@/ui/logger'
import type { AgentState } from '@/api/types'
import { DshRemoteLauncher } from './dshRemoteLauncher'
import { DshSession } from './session'
import type { DshMode } from './types'

export async function runDsh(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'remote'
    existingSessionId?: string
    /** Fresh machine-spawn stub (`--hapi-session-id`); adopt via bootstrapSession. */
    reservedSessionId?: string
    workingDirectory?: string
    resumeSessionId?: string
    permissionMode?: 'default' | 'read-only' | 'yolo'
    model?: string
    effort?: string
    modelReasoningEffort?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'
    const startingMode = 'remote' as const
    const initialState: AgentState = {
        controlledByUser: false,
        startingMode
    }

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'dsh',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'dsh',
            startedBy,
            workingDirectory,
            agentState: initialState,
            reservedSessionId: opts.reservedSessionId
        })
    const { api, session } = bootstrap
    setControlledByUser(session, startingMode)

    // DSH 一轮只接一条用户消息：排队消息逐条处理，不要合并成一个 prompt。
    const queue = new MessageQueue2<DshMode>((mode) => hashObject(mode), null, { maxBatchSize: 1 })
    const sessionRef: { current: DshSession | null } = { current: null }
    const launcherRef: { current: DshRemoteLauncher | null } = { current: null }

    session.onUserMessage((message, localId) => {
        queue.push(
            formatMessageWithAttachments(message.content.text, message.content.attachments),
            'dsh',
            localId,
            message.content.attachments
        )
    })
    session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        stopKeepAlive: () => sessionRef.current?.stopKeepAlive(),
        onBeforeClose: () => launcherRef.current?.kill()
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session)

    const dshSession = new DshSession({
        api,
        client: session,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        messageQueue: queue,
        onModeChange: () => {},
        startedBy,
        permissionMode: opts.permissionMode,
        sessionId: opts.resumeSessionId ?? session.getMetadata()?.dshSessionId ?? null
    })
    const launcher = new DshRemoteLauncher(dshSession, {
        model: opts.model,
        effort: opts.effort,
        modelReasoningEffort: opts.modelReasoningEffort
    })
    sessionRef.current = dshSession
    launcherRef.current = launcher

    let crashed = false
    try {
        await launcher.launch()
    } catch (error) {
        crashed = true
        session.sendSessionEvent({ type: 'error', ...formatDshError(error) })
        lifecycle.markCrash(error)
    } finally {
        if (!crashed) lifecycle.setSessionEndReason('completed')
        await lifecycle.cleanupAndExit()
    }
}
