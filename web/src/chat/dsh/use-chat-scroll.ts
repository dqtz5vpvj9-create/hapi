// Adapted from DeepSeek Harness 5badb150 (MIT); see ./LICENSE and README.md.
/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ChatSnapshot } from './types'
import type { ChatViewSlotProps } from './types'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation'
import { useChatReading, type ChatReadingState } from './use-chat-reading'
import { useChatViewport, type ChatViewport, type ViewportScroll } from './use-chat-viewport'

/** Committed content and Session operations used to reconcile scroll ownership. */
export interface ChatScrollInput extends ChatNavigationInput {
  readonly chatScroll: ChatViewSlotProps['chatScroll']
  readonly ready: boolean
  readonly order: readonly string[]
  readonly lastKey: string | null
  readonly lastIsUser: boolean
  readonly steeringId: string | null
  readonly submissionId: string | null
  readonly running: boolean
  readonly loadedTurns: ReturnType<ChatSnapshot['navigation']['items']>
  /** HAPI's bounded source can replace an epoch while keeping this view open. */
  readonly historyEpoch?: number | null
  /** Deliver attribution before Reading acknowledges or follows this geometry. */
  readonly onViewportScroll?: (scroll: ViewportScroll) => void
}

interface ChatScrollState extends ChatReadingState {
  readonly viewport: ChatViewport
  readonly reading: import('./use-chat-reading').ChatReading
  readonly navigation: ChatNavigation
  readonly listRef: RefObject<HTMLDivElement | null>
  readonly columnRef: RefObject<HTMLDivElement | null>
  readonly busyTurn: number | null
  readonly busy: boolean
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
  readonly returnToBottom: () => void
}

/**
 * Coordinate scroll policy after Chat content commits.
 * New submitted input supersedes pending reader sampling.
 * @param input - current Chat content, scroll memory, and history operations.
 * @returns element refs, visible reading state, and navigation callbacks.
 */
export function useChatScroll(input: ChatScrollInput, adapter?: ChatViewport): ChatScrollState {
  const {
    ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, running,
    loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough, historyEpoch, onViewportScroll,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport(adapter)
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough])
  const { navigation, busyTurn, busy } = useChatNavigation(viewport, reading, navigationInput)
  const content = useRef<{ input: ChatScrollInput; applied: ChatScrollInput | null; opened: boolean }>({
    input, applied: null, opened: false,
  })

  const processContent = useCallback(() => {
    const current = content.current.input
    // Resize can fire before HAPI's first window arrives. An empty DOM at
    // that point is not an opened empty conversation or a follow-tail commit.
    if (!current.ready) return
    const previous = content.current.applied
    const ownInput = (current.lastIsUser && current.lastKey !== previous?.lastKey)
      || (current.steeringId !== null && current.steeringId !== previous?.steeringId
        && current.steeringId !== previous?.submissionId)
      || (current.submissionId !== null && current.submissionId !== previous?.submissionId
        && current.submissionId !== previous?.steeringId)
    if (reading.pending && !ownInput) return
    content.current.applied = current
    if (current.ready && !content.current.opened) {
      // HAPI: a loaded virtual anchor may need a mount commit before restore.
      // Open once the actual landing completes, including empty success.
      if (!reading.initialized) reading.restore()
      content.current.opened = reading.initialized
      return
    }
    if (ownInput) {
      navigation.cancel()
      reading.followTail()
      return
    }
    if (previous?.historyEpoch != null && current.historyEpoch !== previous.historyEpoch) {
      const recovered = current.chatScroll.read()
      navigation.cancel()
      if (recovered) {
        reading.pauseFollowing()
        viewport.beginPreserving(recovered)
      }
    }
    if (navigation.contentCommitted()) {
      navigation.reconcile()
      return
    }
    const tipChanged = previous === null || current.ready !== previous.ready
      || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey
      || current.order.length !== previous.order.length || current.running !== previous.running
      || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId
    if (tipChanged && reading.followingTail) {
      navigation.cancel()
      reading.followTail()
    } else navigation.reconcile()
  }, [reading, navigation, viewport])

  useLayoutEffect(() => {
    const disconnectViewport = viewport.connect({
      scroll: event => {
        content.current.input.onViewportScroll?.(event)
        reading.onScroll(event)
      },
      scrollEnd: () => {
        reading.onScrollEnd()
        navigation.readerSettled()
      },
      interact: () => { content.current.opened = true; navigation.cancel() },
      resize: () => {
        if (!content.current.opened) { processContent(); return }
        if (!navigation.contentCommitted()) reading.onResize()
        navigation.reconcile()
      },
    })
    const disconnectReading = reading.connect((sample) => {
      navigation.readerSampled(sample)
      processContent()
    })
    return () => {
      disconnectViewport()
      disconnectReading()
      content.current.opened = false
      content.current.applied = null
    }
  }, [viewport, reading, navigation, processContent])

  useLayoutEffect(() => {
    const previous = content.current.input
    content.current.input = {
      ready, order, lastKey, lastIsUser, steeringId, submissionId, running, loadedTurns, chatScroll, historyEpoch, onViewportScroll, ...navigationInput,
    }
    viewport.updateTurns(loadedTurns)
    const layoutChanged = previous.order !== order || previous.ready !== ready
    if (layoutChanged) viewport.invalidate()
    processContent()
    if (layoutChanged) reading.refreshActiveTurn()
  }, [
    viewport, reading, processContent, navigationInput, ready, order, lastKey, lastIsUser,
    steeringId, submissionId, running, loadedTurns, chatScroll, historyEpoch, onViewportScroll,
  ])

  const returnToBottom = useCallback(() => {
    navigation.cancel()
    reading.followTail()
  }, [navigation, reading])

  return {
    listRef, columnRef, viewport, reading, navigation, ...state, busyTurn, busy,
    navigateToTurn: navigation.navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    returnToBottom,
  }
}
