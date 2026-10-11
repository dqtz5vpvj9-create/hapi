import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { toSessionSummary, reconcileSessionSnapshot, classifySessionActivity } from '@hapi/protocol'
import { SessionSchema } from '@hapi/protocol/schemas'
import { applySessionDetailPatch } from './sessionPatch'
import { applySessionSummaryPatch, reconcileSessionSummary } from './sessionSummaryPatch'
import { useRelativeTimeClock } from '@/hooks/useRelativeTimeClock'
import { configureSessionReadSync, hydrateSessionReadStates, markSessionSeen, markSessionUnread,
    getSessionLastSeenAt, getSessionManualUnreadAt, acceptSessionReadState } from './sessionLastSeen'

const session = () => SessionSchema.parse({ id: 'session', namespace: 'n', seq: 1, createdAt: 1, updatedAt: 3000,
    active: true, activeAt: 3000, thinking: false, thinkingAt: 3000, metadata: { host: 'h', path: '/p', flavor: 'codex' },
    metadataVersion: 1, agentState: null, agentStateVersion: 1, executionVersion: 3 })
afterEach(() => { vi.useRealTimers() })

describe('execution version ordering', () => {
    it('rejects an old Running patch in both list and detail, while accepting newer independent metadata', () => {
        const current = session()
        const patch = { executionVersion: 2, thinking: true, activeAt: 2000,
            metadata: { version: 2, value: { host: 'h', path: '/p', name: 'renamed' } } }
        const detail = applySessionDetailPatch(current, patch)!
        const summary = applySessionSummaryPatch(toSessionSummary(current), patch)
        expect(detail.thinking).toBe(false); expect(detail.activeAt).toBe(3000)
        expect(summary.thinking).toBe(false); expect(summary.activeAt).toBe(3000)
        expect(detail.metadata?.name).toBe('renamed'); expect(summary.metadata?.name).toBe('renamed')
    })
    it('does not let a late REST/full SSE snapshot undo a newer state', () => {
        const current = session(); const old = { ...current, executionVersion: 2, thinking: true }
        expect(reconcileSessionSnapshot(current, old).thinking).toBe(false)
        expect(reconcileSessionSummary(toSessionSummary(current), toSessionSummary(old)).thinking).toBe(false)
        expect(applySessionDetailPatch(current, { thinking: true })).toBeNull()
    })
    it('keeps execution running with an asynchronous question but treats a blocking question as waiting', () => {
        const current = session(); current.thinking = true
        current.agentState = { requests: { async: { tool: 'request_user_input', blocking: false, arguments: {} } } }
        expect(classifySessionActivity(toSessionSummary(current))).toMatchObject({ kind: 'running', running: true, pending: true })
        current.agentState.requests!.async.blocking = true
        expect(classifySessionActivity(toSessionSummary(current))).toMatchObject({ kind: 'input', running: false })
        current.active = false
        expect(classifySessionActivity(toSessionSummary(current))).toMatchObject({ kind: 'offline', running: false })
    })
})

it('advances the relative-time clock without session updates and releases its timer on unmount', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T12:00:10Z'))
    const hook = renderHook(useRelativeTimeClock)
    const before = hook.result.current
    act(() => { vi.advanceTimersByTime(50000) })
    expect(hook.result.current).toBeGreaterThan(before)
    hook.unmount(); expect(vi.getTimerCount()).toBe(0)
})

describe('shared read state', () => {
    it('applies another device read/unread and rejects an old replay', () => {
        configureSessionReadSync('presence-other-device', async () => { throw new Error('unused') })
        hydrateSessionReadStates({ session: { version: 1, seenAt: 1000, manualUnreadAt: null } })
        acceptSessionReadState('session', { version: 3, seenAt: 2000, manualUnreadAt: 2000 })
        acceptSessionReadState('session', { version: 2, seenAt: 2000, manualUnreadAt: null })
        expect(getSessionManualUnreadAt('session')).toBe(2000)
        expect(getSessionLastSeenAt('session')).toBe(1999)
        acceptSessionReadState('session', { version: 4, seenAt: 2000, manualUnreadAt: null })
        expect(getSessionLastSeenAt('session')).toBe(2000)
    })
    it('does not let a stale automatic read clear another device explicit unread', async () => {
        const sync = vi.fn(async () => ({ applied: false, state: { version: 2, seenAt: 1000, manualUnreadAt: 1000 } }))
        configureSessionReadSync('presence-conflict', sync)
        hydrateSessionReadStates({ session: { version: 1, seenAt: 900, manualUnreadAt: null } })
        markSessionSeen('session', 1000)
        await vi.waitFor(() => expect(getSessionManualUnreadAt('session')).toBe(1000))
        expect(sync).toHaveBeenCalledTimes(1)
    })
    it('isolates local cache across users and hubs', () => {
        configureSessionReadSync('presence-user-A', async () => { throw new Error('offline') })
        markSessionUnread('session', 1000)
        configureSessionReadSync('presence-user-B', async () => { throw new Error('offline') })
        expect(getSessionManualUnreadAt('session')).toBeNull()
    })
})

it('keeps an offline unread intent across a reload and rejects another account snapshot', async () => {
    const { disconnectSessionReadSync } = await import('./sessionLastSeen')
    configureSessionReadSync('presence-offline-persistent', async () => { throw new Error('offline') })
    markSessionUnread('offline-session', 3000)
    await Promise.resolve()
    disconnectSessionReadSync()
    const sync = vi.fn(async () => ({ applied: true, state: { version: 2, seenAt: 3000, manualUnreadAt: 3000 } }))
    configureSessionReadSync('presence-offline-persistent', sync)
    hydrateSessionReadStates({ 'offline-session': { version: 1, seenAt: 3000, manualUnreadAt: null } })
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    expect(getSessionManualUnreadAt('offline-session')).toBe(3000)
    hydrateSessionReadStates({ 'offline-session': { version: 999, seenAt: 9000, manualUnreadAt: null } }, 'another-account')
    expect(getSessionManualUnreadAt('offline-session')).toBe(3000)
})


it('keeps identical native thread ids separate by machine and store in the visible list', async () => {
    const { deduplicateSessionsByAgentId } = await import('@/components/SessionList')
    const base = toSessionSummary(session())
    const rows = [['linux','store-a'], ['windows','store-a'], ['linux','store-b']].map(([machineId, codexStoreId], index) => ({
        ...base, id: `native-${index}`, metadata: { ...base.metadata!, flavor: 'codex', agentSessionId: 'same-thread', machineId, codexStoreId }
    }))
    expect(deduplicateSessionsByAgentId(rows)).toHaveLength(3)
})
