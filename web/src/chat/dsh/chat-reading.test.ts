// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ChatReading } from './use-chat-reading'
import { ScrollFollow } from './use-scroll-follow'
import type { ChatViewport, ViewportLanding } from './use-chat-viewport'
import type { ChatScrollPosition } from './types'

afterEach(() => { vi.useRealTimers() })

function pendingRestoration() {
  const position: ChatScrollPosition = {
    anchorKey: 'code-answer', anchorTop: -18000, scrollTop: 0,
    reading: { id: 'code-answer', topOffset: -18000,
      code: { source: 0, position: 112020, quote: 'record870', quoteStart: 112020, topOffset: 92 } },
  }
  const metrics = { top: 400, floor: 1000, height: 600 }
  const store = { read: () => position, save: vi.fn() }
  const viewport = {
    restore: vi.fn<() => ViewportLanding | null>(() => null),
    navigationSettled: vi.fn(), latestTurn: 320,
    readScroll: vi.fn(() => ({ metrics, movedByReader: false })),
    capturePosition: vi.fn(() => position), acknowledge: vi.fn(),
    readVisibleTurn: vi.fn(() => 318),
  }
  const reading = new ChatReading(viewport as unknown as ChatViewport, store,
    { initialized: false, followingTail: false, activeTurn: 320 }, vi.fn(), new ScrollFollow(false, 25))
  return { reading, viewport, store, position, metrics }
}

it('keeps the saved source bookmark through intermediate restoration writes until a landing completes', () => {
  vi.useFakeTimers()
  const { reading, viewport, store, position, metrics } = pendingRestoration()
  reading.restore()
  reading.onScroll({ metrics, movedByReader: false })
  reading.refreshActiveTurn()
  reading.onResize()
  reading.onScrollEnd()
  vi.runAllTimers()
  expect(reading.initialized).toBe(false)
  expect(reading.pending).toBe(false)
  expect(viewport.capturePosition).not.toHaveBeenCalled()
  expect(store.save).not.toHaveBeenCalled()

  viewport.restore.mockReturnValue({ metrics, position, turn: 318 })
  reading.restore()
  expect(reading.initialized).toBe(true)
  expect(reading.followingTail).toBe(false)
  expect(store.save).toHaveBeenCalledWith(position)
  expect(viewport.navigationSettled).toHaveBeenCalledWith({ metrics, position, turn: 318 })
  reading.dispose()
})

it('still accepts genuine reader movement while initial restoration is pending', () => {
  vi.useFakeTimers()
  const { reading, viewport, store, metrics } = pendingRestoration()
  const chosen = { anchorKey: 'user-chosen-row', anchorTop: 10, scrollTop: 400 }
  viewport.readScroll.mockReturnValue({ metrics, movedByReader: true })
  viewport.capturePosition.mockReturnValue(chosen)
  reading.restore()
  reading.onScroll({ metrics, movedByReader: true })
  reading.onScrollEnd()
  expect(reading.initialized).toBe(true)
  expect(store.save).toHaveBeenCalledWith(chosen)
  reading.dispose()
})
