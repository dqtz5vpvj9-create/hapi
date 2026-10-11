import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let now = Date.now()
function tick() {
    now = Date.now()
    for (const listener of listeners) listener()
    timer = listeners.size ? setTimeout(tick, 60_000 - Date.now() % 60_000) : undefined
}
function subscribe(listener: () => void) {
    listeners.add(listener)
    if (!timer) { now = Date.now(); timer = setTimeout(tick, 60_000 - now % 60_000) }
    return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(timer); timer = undefined } }
}
/** One clock for all visible rows; no list sorting, polling or per-row timers. */
export function useRelativeTimeClock(): number {
    return useSyncExternalStore(subscribe, () => now, () => 0)
}
