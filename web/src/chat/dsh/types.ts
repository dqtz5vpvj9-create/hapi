/** Minimal DSH view contracts. No plugin engine or duplicate transcript store. */
import type { ReadingAnchor } from '@/lib/reading-anchor'

export type SessionSeq = number
export type ChatNode = { anchorSeq: number }
export type ChatScrollPosition = {
    anchorKey: string
    anchorTop: number
    scrollTop: number
    /** HAPI adapter extension: character and CodeMirror positions. */
    reading?: ReadingAnchor
}
export type TurnNavigationItem = { turn: number; anchorKey: string }
export type ChatSnapshot = { navigation: { items: () => readonly TurnNavigationItem[] } }
export type ChatViewSlotProps = {
    loadOlder: () => void
    loadThrough: (seq: number) => Promise<void>
    chatScroll: {
        save: (position: ChatScrollPosition | null) => void
        read: () => ChatScrollPosition | null
    }
}
export type TurnRailItem = {
    turn: number
    /** HAPI: End targets the mounted end of a virtual window. */
    align?: 'start' | 'end'
    anchor: { kind: 'loaded'; key: string } | { kind: 'unloaded'; seq: number }
}
