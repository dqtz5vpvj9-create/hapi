// Adapted from DeepSeek Harness 5badb150 (MIT); see ./LICENSE and README.md.
/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
import { useLayoutEffect, useState } from 'react'
import type { SessionSeq } from './types'
import type { ChatNode } from './types'
import type { ChatViewSlotProps } from './types'
import type { TurnRailItem } from './types'
import type { ChatReading, ReadingSample } from './use-chat-reading'
import type { ChatViewport } from './use-chat-viewport'

/** History availability and loading operations for the committed Chat window. */
export interface ChatNavigationInput extends Pick<ChatViewSlotProps, 'loadOlder' | 'loadThrough'> {
  readonly firstSeq: ChatNode['anchorSeq'] | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
}

interface TurnJump {
  readonly turn: number
  readonly align?: 'start' | 'end'
  readonly seq: SessionSeq
  phase: 'loading' | 'settled'
  landing: 'pending' | 'landed' | 'interrupted'
  repageHead: ChatNavigationInput['firstSeq']
}

/** Owns one replaceable turn jump and the anchor retained while history loads. */
export class ChatNavigation {
  private jump: TurnJump | null = null
  private settleFrame: number | null = null
  private resolution: object | null = null

  constructor(
    private readonly viewport: ChatViewport,
    private readonly reading: ChatReading,
    private input: ChatNavigationInput,
    private readonly onBusyTurn: (turn: number | null) => void,
    private readonly onResolving: (resolving: boolean) => void = () => {},
  ) {}

  /**
   * Adopt committed history availability without starting a request.
   * @param input - history state from the latest committed render.
   */
  setInput(input: ChatNavigationInput): void { this.input = input }

  /** Cancel navigation when opening a Chat view. */
  reset(): void {
    this.cancel()
  }

  /** Cancel local callbacks; late history completions cannot revive a task. */
  dispose(): void {
    this.clearTask()
  }

  /** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
  cancel(): void {
    this.clearTask()
    this.onBusyTurn(null)
  }

  private clearTask(): void {
    this.cancelFrame()
    this.jump = null
    this.resolution = null
    this.onResolving(false)
    this.viewport.stopPreserving()
  }

  /** HAPI metadata-only labels can name an archived message before its ordinal
   * is loaded. Resolve that identity as part of this same cancellable task. */
  readonly resolveTarget = (resolve: (isCurrent: () => boolean) => Promise<TurnRailItem | null>): void => {
    this.cancel()
    this.reading.pauseFollowing()
    this.viewport.beginPreserving()
    const task = {}
    this.resolution = task
    this.onResolving(true)
    const current = () => this.resolution === task
    void resolve(current).then(item => {
      if (!current()) return
      if (item) this.navigateToTurn(item)
      else this.cancel()
    }, () => { if (current()) this.cancel() })
  }

  /**
   * Replace the current jump with an explicit turn selection.
   * @param item - loaded anchor or unloaded turn to fetch before landing.
   */
  readonly navigateToTurn = (item: TurnRailItem): void => {
    if (item.anchor.kind === 'loaded') {
      this.cancel()
      const landing = this.viewport.scrollToTurn(item.turn, item.align)
      if (landing === null) return
      this.reading.acceptNavigation(landing)
      if (this.input.loadingOlder) this.viewport.beginPreserving(landing.position)
      return
    }
    this.cancel()
    this.viewport.beginPreserving()
    this.reading.pauseFollowing()
    const jump: TurnJump = {
      turn: item.turn,
      align: item.align,
      seq: item.anchor.seq,
      phase: 'loading',
      landing: 'pending',
      repageHead: null,
    }
    this.jump = jump
    this.onBusyTurn(jump.turn)
    this.request(jump)
  }

  /** Request one older page while retaining the current semantic position. */
  readonly loadEarlier = (): void => {
    this.cancel()
    this.viewport.beginPaging()
    this.reading.pauseFollowing()
    this.input.loadOlder()
  }

  /**
   * Preserve reader ownership across pending history work.
   * @param sample - settled reader movement that can update or interrupt an anchor.
   */
  readerSampled(sample: ReadingSample): void {
    if (sample.movedByReader && this.jump?.landing === 'landed') this.jump.landing = 'interrupted'
    if (sample.followingTail || sample.movedByReader) this.viewport.stopPreserving()
  }

  /**
   * Preserve one paging anchor after a commit or a later size change, regardless of head identity.
   * @returns whether the retained anchor handled the layout change.
   */
  contentCommitted(): boolean {
    if (!this.viewport.preserving || this.reading.pending) return false
    if (this.landJump(false)) return true
    const landing = this.viewport.preserve()
    if (landing === null) return false
    this.reading.preservePosition(landing)
    return true
  }

  /** Retarget a still-loading page only after inner or outer reader scrolling ends. */
  readerSettled(): void {
    if (this.input.loadingOlder && this.jump === null && !this.viewport.preserving && !this.reading.followingTail) {
      this.viewport.beginPreserving()
    }
  }

  /** Land, retry, or complete the current jump against the committed window. */
  reconcile(): void {
    const jump = this.jump
    if (jump === null || this.reading.pending) return
    if (jump.phase === 'loading') {
      if (jump.landing === 'pending') this.landJump(false)
      return
    }
    if (this.input.loadingOlder) return
    if (this.landJump(true)) return
    // The reference mounts the whole transcript. HAPI must retain this same
    // navigation task while its already-loaded destination is being mounted.
    if (this.viewport.isTurnMountPending(jump.turn)) return
    const uncovered = this.input.firstSeq === null || this.input.firstSeq > jump.seq
    if (uncovered && this.input.hasMore && jump.repageHead !== this.input.firstSeq) {
      jump.repageHead = this.input.firstSeq
      this.viewport.beginPreserving()
      this.request(jump)
      return
    }
    const fallback = this.viewport.scrollToTurnAtOrAfter(jump.turn)
    this.cancel()
    if (fallback !== null) this.reading.acceptNavigation(fallback)
  }

  private landJump(settle: boolean): boolean {
    const jump = this.jump
    if (jump === null) return false
    if (jump.landing === 'interrupted') {
      if (settle) { this.cancel(); return true }
      return false
    }
    const landing = this.viewport.scrollToTurn(jump.turn, jump.align)
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (settle) { this.cancel(); this.viewport.navigationSettled(landing) }
    else {
      this.viewport.beginPreserving(landing.position)
      jump.landing = 'landed'
    }
    return true
  }

  private request(jump: TurnJump): void {
    jump.phase = 'loading'
    const settled = (): void => {
      if (this.jump !== jump) return
      jump.phase = 'settled'
      this.cancelFrame()
      if (typeof requestAnimationFrame !== 'function') this.reconcile()
      else this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = null
        if (this.jump === jump) this.reconcile()
      })
    }
    void this.input.loadThrough(jump.seq).then(settled, settled)
  }

  private cancelFrame(): void {
    if (this.settleFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.settleFrame)
    this.settleFrame = null
  }
}

/**
 * Retain one navigation owner for the component's lifetime.
 * @param viewport - turn-aware DOM operations.
 * @param reading - reading and follow policy receiving navigation landings.
 * @param input - committed history state and load operations.
 * @returns the navigation owner and its visible busy turn.
 */
export function useChatNavigation(
  viewport: ChatViewport, reading: ChatReading, input: ChatNavigationInput,
): { navigation: ChatNavigation; busyTurn: number | null; busy: boolean } {
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [resolving, setResolving] = useState(false)
  const [navigation] = useState(() => new ChatNavigation(viewport, reading, input, setBusyTurn, setResolving))
  useLayoutEffect(() => { navigation.setInput(input) }, [navigation, input])
  useLayoutEffect(() => () => { navigation.dispose() }, [navigation])
  return { navigation, busyTurn, busy: resolving || busyTurn !== null }
}
