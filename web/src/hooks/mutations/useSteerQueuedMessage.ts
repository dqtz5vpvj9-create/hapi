import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { markMessagesConsumed, markMessagesDispatching, syncTailMessages } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

type SteerQueuedMessageInput = {
    sessionId: string
    messageId: string
}

/**
 * Mutation: deliver one queued message into the active Pi turn (native steer).
 *
 * Never optimistically remove a row. After acknowledgment, hold it while
 * reconciling through SSE or an authoritative read. This also recovers when
 * the consumption event was missed. A transport failure is not evidence that
 * the message stayed queued: report uncertainty and refresh its real status.
 */
export function useSteerQueuedMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    const { addToast } = useToast()

    const mutation = useMutation({
        mutationFn: async (input: SteerQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.steerMessage(input.sessionId, input.messageId)
        },
        onSuccess: (result, input) => {
            if (result.status === 'failed') {
                addToast({
                    title: t('queuedMessages.steerFailed'),
                    body: result.error ?? '',
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
                return
            }
            if (result.status === 'invoked' && result.message.localId && typeof result.message.invokedAt === 'number') {
                // The CLI consumed this message before the steer arrived. If the
                // messages-consumed SSE was missed while the row was still
                // queued, reconcile it now so the queued bar cannot keep a
                // stale actionable row (mirrors useCancelQueuedMessage).
                markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
            }
            if (result.status === 'steered') {
                markMessagesDispatching(input.sessionId, [result.localId])
            }
        },
        onSettled: async (_result, _error, input) => {
            // Keep actions locked until this read finishes. Never resubmit the
            // steer, and preserve the user's position when reading history.
            if (api) await syncTailMessages(api, input.sessionId, { ensureAfterCurrent: true }).catch(() => {})
        },
        onError: (error, input) => {
            addToast({
                title: t('queuedMessages.steerFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId: input.sessionId,
                url: window.location.href,
            })
        },
    })

    return mutation
}
