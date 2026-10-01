import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AssistantRuntimeProvider, ThreadPrimitive, unstable_useThreadMessageIds } from '@assistant-ui/react'
import { HappyChatProvider, useHappyChatContext } from '@/components/AssistantChat/context'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { Session } from '@/types/api'
import type { ComponentProps } from 'react'

export type TurnSnapshot = { html: string; text: string; role?: 'user' | 'assistant' }

function CaptureRows(props: {
    container: HTMLDivElement
    components: ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']
    onCapture: (snapshots: TurnSnapshot[]) => void
    onError: () => void
}) {
    const ids = unstable_useThreadMessageIds()
    useEffect(() => {
        let disposed = false
        let cancelWait = () => {}
        const waitForMedia = () => new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>
            const observer = new MutationObserver(check)
            function stop() { observer.disconnect(); clearTimeout(timer) }
            function check() {
                if (props.container.querySelector('[data-hapi-share-media-state="error"]')) {
                    stop(); reject(new Error('Image loading failed')); return
                }
                if (!props.container.querySelector('[data-hapi-share-media-state="loading"]')) {
                    stop(); resolve()
                }
            }
            cancelWait = () => { stop(); reject(new Error('Capture cancelled')) }
            observer.observe(props.container, { childList: true, subtree: true, attributes: true })
            timer = setTimeout(() => { stop(); reject(new Error('Image loading timed out')) }, 15_000)
            check()
        })
        void (async () => {
            await waitForMedia()
            const images = Array.from(props.container.querySelectorAll('img'))
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Image decode timed out')), 15_000)
                cancelWait = () => { clearTimeout(timer); reject(new Error('Capture cancelled')) }
                for (const image of images) image.loading = 'eager'
                Promise.all(images.map(image => image.decode())).then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
            })
            if (disposed) return
            const media = new Map<string, string>()
            let mediaBytes = 0
            for (const image of images) {
                if (!image.src.startsWith('blob:') || media.has(image.src)) continue
                const blob = await fetch(image.src).then(response => response.blob())
                mediaBytes += blob.size
                if (mediaBytes > 8 * 1024 * 1024) throw new Error('Export images exceed 8 MB')
                const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader()
                    reader.onload = () => resolve(reader.result as string)
                    reader.onerror = () => reject(reader.error)
                    reader.readAsDataURL(blob)
                })
                media.set(image.src, data)
            }
            if (disposed) return
            const snapshots = Array.from(props.container.querySelectorAll<HTMLElement>('[data-hapi-message-role]'))
                .filter(row => ['user', 'assistant'].includes(row.dataset.hapiMessageRole ?? ''))
                .map(row => {
                    const copy = row.cloneNode(true) as HTMLElement
                    copy.removeAttribute('id')
                    for (const image of copy.querySelectorAll('img')) {
                        const data = media.get(image.src)
                        if (data) image.src = data
                    }
                    return { html: copy.outerHTML, text: (row.innerText || row.textContent || '').trim(),
                        role: row.dataset.hapiMessageRole as 'user' | 'assistant' }
                })
            props.onCapture(snapshots)
        })().catch(() => { if (!disposed) props.onError() })
        return () => { disposed = true; cancelWait() }
    }, [ids, props.container, props.onCapture, props.onError])
    return ids.map(id => <ThreadPrimitive.Unstable_MessageById key={id} messageId={id} components={props.components} />)
}

/** The complete data projection renders into a detached portal: no duplicate
 * navigation IDs, viewport measurements, scroll movement or persistent rows. */
export function ShareTurnCapture(props: {
    session: Session
    blocks: readonly VisibleChatBlock[]
    components: ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']
    onCapture: (snapshots: TurnSnapshot[]) => void
    onError: () => void
}) {
    const context = useHappyChatContext()
    const captureContext = { ...context, disabled: true, onContinuePlan: undefined, onRetryMessage: undefined,
        onDiscardFailedMessage: undefined, onForkConversation: undefined, onRewindConversation: undefined,
        onShareTurn: undefined, onNestedScrollFollowChange: undefined,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop' as const }
    const container = useMemo(() => document.createElement('div'), [])
    const runtime = useHappyRuntime({ session: props.session, blocks: props.blocks,
        messagesVersion: 0, historyVersion: 0, viewMode: 'history',
        isSending: false, isRunning: false, onSendMessage: () => {}, onAbort: async () => {} })
    return createPortal(
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyChatProvider value={captureContext}>
                <CaptureRows container={container} components={props.components} onCapture={props.onCapture} onError={props.onError} />
            </HappyChatProvider>
        </AssistantRuntimeProvider>, container,
    )
}
