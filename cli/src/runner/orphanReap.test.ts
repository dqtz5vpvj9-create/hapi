import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    commandMatchesRunnerSpawnedSession,
    findRunnerSpawnedOrphanTargets,
    findStopSessionOrphanTargets,
    reapRunnerSpawnedOrphans,
    selectOrphanTargetsForSession,
} from './orphanReap'
import {
    WINDOWS_CIM_CREATION_DATE_MARKER_EXPR,
    windowsProcessListCimCommand,
    windowsProcessMarkerCimCommand,
} from '@/utils/process'

describe('orphanReap argv matching', () => {
    const sessionId = 'sess-abc-123'

    it('matches runner-spawned CLI with --existing-session-id', () => {
        const cmd = `bun src/index.ts claude --hapi-starting-mode remote --started-by runner --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('matches --hapi-session-id= form', () => {
        const cmd = `hapi cursor --started-by=runner --hapi-session-id=${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('rejects terminal-started sessions', () => {
        const cmd = `bun src/index.ts claude --started-by terminal --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects --resume native id that merely equals the session string', () => {
        // Guard: native agent resume ids must not be treated as HAPI row ids.
        const cmd = `bun src/index.ts cursor --resume ${sessionId} --started-by runner`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects substring false positives', () => {
        const cmd = `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}-extra`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('treats empty Windows process-list stdout as scan_failed (not no-orphans)', async () => {
        // listWindowsProcessesWithCommandLine throws on empty stdout; catch →
        // scan_failed so archive does not fail-open as already_gone (#1911).
        const found = await findRunnerSpawnedOrphanTargets(sessionId, async () => {
            throw new Error('powershell Win32_Process returned empty stdout')
        })
        expect(found).toBe('scan_failed')
    })

    it('treats signalled ps (status null) as scan_failed (#1911 Overseer B1)', async () => {
        const found = await findRunnerSpawnedOrphanTargets(sessionId, async () => {
            throw new Error('ps aborted (signal)')
        })
        expect(found).toBe('scan_failed')
    })

    it('selectOrphanTargetsForSession filters non-hapi and self', () => {
        const targets = selectOrphanTargetsForSession(
            [
                { pid: 1, cmd: 'systemd', name: 'systemd' },
                { pid: 42, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
                { pid: 43, cmd: `bun src/index.ts claude --started-by runner --existing-session-id other`, name: 'bun' },
                { pid: process.pid, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
            ],
            sessionId
        )
        expect(targets).toEqual([{ pid: 42, startMarker: null }])
    })

    it('selectOrphanTargetsForSession coerces string PIDs from process snapshots', () => {
        const targets = selectOrphanTargetsForSession(
            [
                {
                    // Some process listers return string PIDs; Number.isFinite("42") is false.
                    pid: '42' as unknown as number,
                    cmd: `hapi.exe cursor --started-by runner --existing-session-id ${sessionId}`,
                    name: 'hapi.exe',
                },
            ],
            sessionId
        )
        expect(targets).toEqual([{ pid: 42, startMarker: null }])
    })

    it('matches win32 CIM snapshots that include CommandLine', () => {
        const targets = selectOrphanTargetsForSession(
            [
                {
                    pid: 99,
                    name: 'hapi.exe',
                    cmd: `"C:\\\\Temp\\\\hapi.exe" /c keep.cmd --started-by runner --existing-session-id ${sessionId}`,
                },
                {
                    pid: 100,
                    name: 'hapi.exe',
                    cmd: '', // name-only (fastlist shape) cannot argv-match
                },
            ],
            sessionId
        )
        expect(targets).toEqual([{ pid: 99, startMarker: null }])
    })
})

describe('reapRunnerSpawnedOrphans (stopSession orphan path)', () => {
    it('returns null when no argv orphans match', async () => {
        const status = await reapRunnerSpawnedOrphans('missing-session', {
            findTargets: async () => [],
            killTree: async () => {
                throw new Error('should not kill')
            },
            getStartMarker: () => 'unused',
        })
        expect(status).toBeNull()
    })

    it('kills matching orphan PIDs and returns stopped when maps would have missed', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-1', {
            findTargets: async (sessionId) => {
                expect(sessionId).toBe('sess-orphan-1')
                return [{ pid: 4242, startMarker: 'gen-stable' }, { pid: 4243, startMarker: 'gen-stable' }]
            },
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: () => 'gen-stable',
        })
        expect(status).toBe('stopped')
        expect(killed).toEqual([4242, 4243])
    })

    it('returns still_alive when the process scan fails', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-scan-fail', {
            findTargets: async () => 'scan_failed',
            killTree: async () => {
                throw new Error('should not kill')
            },
        })
        expect(status).toBe('still_alive')
    })

    it('returns still_alive when tree-kill cannot prove death', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-2', {
            findTargets: async () => [{ pid: 9999, startMarker: 'gen-a' }],
            killTree: async () => false,
            getStartMarker: () => 'gen-a',
        })
        expect(status).toBe('still_alive')
    })

    it('does not kill when start marker changes between snapshot and kill (PID reuse)', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-reuse', {
            findTargets: async () => [{ pid: 4242, startMarker: 'gen-orphan' }],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: () => 'gen-reused-unrelated',
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        // Matched generation is gone (PID reused) — treat as resolved, not a kill.
        expect(status).toBe('stopped')
    })

    it('returns still_alive when pre-kill marker probe fails while PID is alive', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-probe-fail', {
            findTargets: async () => [{ pid: 4242, startMarker: 'gen-orphan' }],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: () => null,
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        // Null re-check is not proof of death — must not claim stopped.
        expect(status).toBe('still_alive')
    })

    it('returns still_alive without killing when marker cannot be read for a live orphan', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-no-marker', {
            findTargets: async () => [{ pid: 5555, startMarker: null }],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: () => null,
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        expect(status).toBe('still_alive')
    })

    it('uses same-snapshot startMarker as expected (not a later probe) for PID-reuse guard', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-snapshot', {
            findTargets: async () => [
                { pid: 4242, startMarker: 'snapshot-gen' },
            ],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            // Re-check only — must not be consulted for the expected marker.
            getStartMarker: () => 'snapshot-gen',
            isAlive: () => true,
        })
        expect(status).toBe('stopped')
        expect(killed).toEqual([4242])
    })

    it('continues other orphans when one live PID has an unreadable marker', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-partial', {
            findTargets: async () => [
                { pid: 1111, startMarker: null },
                { pid: 2222, startMarker: 'gen-ok' },
            ],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: (pid) => (pid === 2222 ? 'gen-ok' : null),
            isAlive: () => true,
        })
        expect(killed).toEqual([2222])
        expect(status).toBe('still_alive')
    })

    it('PID-filter on findTargets retains same-snapshot markers (runner stopSession shape)', async () => {
        // Regression: run.ts used findOrphans → number[], which forced a later
        // getStartMarker probe and discarded the argv-snapshot marker (#1911 bot).
        const killed: number[] = []
        const protectedPids = new Set([1111])
        const status = await reapRunnerSpawnedOrphans('sess-orphan-filter', {
            findTargets: async () => {
                const found = [
                    { pid: 1111, startMarker: 'snap-protected' },
                    { pid: 2222, startMarker: 'snap-orphan' },
                ]
                return found.filter((t) => !protectedPids.has(t.pid))
            },
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            // Recheck only — expected marker must stay 'snap-orphan', not this.
            getStartMarker: () => 'snap-orphan',
            isAlive: () => true,
        })
        expect(killed).toEqual([2222])
        expect(status).toBe('stopped')
    })

    it('production findStopSessionOrphanTargets→reap keeps list snapshot markers (not a later probe)', async () => {
        // Drives the same helper run.ts uses — not an injected findOrphans seam.
        const sessionId = 'sess-prod-wiring'
        const snapshotIso = '2026-09-24T15:00:00.0000000Z'
        const listProcesses = async () => [
            {
                pid: 1111,
                name: 'hapi',
                cmd: `hapi cursor --started-by runner --existing-session-id ${sessionId}`,
                startMarker: 'snap-protected',
            },
            {
                pid: 2222,
                name: 'hapi',
                cmd: `hapi cursor --started-by runner --existing-session-id ${sessionId}`,
                startMarker: snapshotIso,
            },
        ]
        const protectedPids = new Set([1111])
        const killed: number[] = []
        let probeCalls = 0

        const status = await reapRunnerSpawnedOrphans(sessionId, {
            findTargets: (id) => findStopSessionOrphanTargets(
                id,
                (_sid, pid) => protectedPids.has(pid),
                listProcesses
            ),
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: (pid) => {
                probeCalls++
                // Recheck only — if expected came from a post-find probe, a wrong
                // generation could slip through. Snapshot must already be snapshotIso.
                return pid === 2222 ? snapshotIso : 'snap-protected'
            },
            isAlive: () => true,
        })

        expect(killed).toEqual([2222])
        expect(status).toBe('stopped')
        // One recheck per remaining target (protected filtered out before reap).
        expect(probeCalls).toBe(1)
    })
})

describe('run.ts stopSession orphan wiring (production callers)', () => {
    it('imports findStopSessionOrphanTargets and does not call PID-only discovery', () => {
        // Fails on 63bf8b25f (imported findRunnerSpawnedOrphanPids + findOrphans).
        const runSrc = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), 'run.ts'),
            'utf8'
        )
        expect(runSrc).toContain('findStopSessionOrphanTargets')
        expect(runSrc).not.toMatch(/\bfindRunnerSpawnedOrphanPids\b/)
        expect(runSrc).not.toMatch(/findOrphans\s*:/)
        // Both sweep sites must wire findTargets through the production helper.
        const findTargetsSites = runSrc.match(/findTargets:\s*\(id\)\s*=>\s*findStopSessionOrphanTargets/g) ?? []
        expect(findTargetsSites.length).toBe(2)
    })
})

describe('Windows orphan startMarker format agreement', () => {
    it('list + single-probe CIM commands stringify CreationDate the same way', () => {
        expect(WINDOWS_CIM_CREATION_DATE_MARKER_EXPR).toContain("ToString('o')")
        expect(windowsProcessListCimCommand()).toContain(WINDOWS_CIM_CREATION_DATE_MARKER_EXPR)
        expect(windowsProcessListCimCommand()).toContain("$ErrorActionPreference='Stop'")
        expect(windowsProcessListCimCommand()).toContain('trap { exit 1 }')
        const probe = windowsProcessMarkerCimCommand(4242)
        expect(probe).toContain("CreationDate.ToUniversalTime().ToString('o')")
        expect(probe).toContain('ProcessId = 4242')
        expect(windowsProcessListCimCommand()).toMatch(/CreationDate.*ToString\('o'\)/)
    })

    it('preserves the CIM creation-date marker when selecting an orphan target', () => {
        const iso = '2026-09-24T15:00:00.0000000Z'
        const sessionId = 'sess-win-marker'
        const targets = selectOrphanTargetsForSession(
            [
                {
                    pid: 4242,
                    name: 'hapi.exe',
                    cmd: `hapi.exe cursor --started-by runner --existing-session-id ${sessionId}`,
                    startMarker: iso, // as listWindowsProcessesWithCommandLine would set
                },
            ],
            sessionId
        )
        expect(targets).toEqual([{ pid: 4242, startMarker: iso }])
    })

    it('reap with list ISO expected + probe ISO current kills; mismatch skips', async () => {
        const iso = '2026-09-24T15:00:00.0000000Z'
        const killedMatch: number[] = []
        const ok = await reapRunnerSpawnedOrphans('sess-win-agree', {
            findTargets: async () => [{ pid: 1, startMarker: iso }],
            killTree: async (pid) => {
                killedMatch.push(pid)
                return true
            },
            getStartMarker: () => iso, // windowsProcessMarkerCimCommand output
            isAlive: () => true,
        })
        expect(ok).toBe('stopped')
        expect(killedMatch).toEqual([1])

        const killedMismatch: number[] = []
        const skipped = await reapRunnerSpawnedOrphans('sess-win-disagree', {
            findTargets: async () => [{ pid: 2, startMarker: iso }],
            killTree: async (pid) => {
                killedMismatch.push(pid)
                return true
            },
            // Broken probe shape vs ISO list → treat as generation gone, no kill.
            getStartMarker: () => '/Date(1727182800000)/',
            isAlive: () => true,
        })
        expect(skipped).toBe('stopped')
        expect(killedMismatch).toEqual([])
    })
})
