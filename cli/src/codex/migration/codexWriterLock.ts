import { closeSync, openSync, unlinkSync, mkdirSync, constants } from 'node:fs'
import { join } from 'node:path'

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const COORDINATION = '.coordination.lock'

type Flock = (fd: number, operation: number) => number
let flock: Flock | undefined

function loadFlock(): Flock {
    if (flock) return flock
    if (process.platform === 'win32') throw new Error('Native Codex writer locks are not available on Windows; refusing online migration')
    if (typeof Bun === 'undefined') throw new Error('Native Codex writer locks require the Bun runtime; refusing online migration')
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi')
    const library = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6'
    try {
        flock = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock as Flock
    } catch {
        flock = dlopen('libc.so', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock as Flock
    }
    return flock
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function acquireCoordination(directory: string): number {
    const fd = openSync(join(directory, COORDINATION), constants.O_RDWR | constants.O_CREAT, 0o600)
    const fn = loadFlock()
    const deadline = Date.now() + 5_000
    while (fn(fd, LOCK_EX | LOCK_NB) !== 0) {
        if (Date.now() >= deadline) { closeSync(fd); throw new Error('Timed out acquiring Codex writer coordination lock') }
        sleep(20)
    }
    return fd
}

function release(fd: number): void { try { loadFlock()(fd, LOCK_UN) } catch { /* best effort */ } }

export type CodexWriterLock = { release(): void }

/** Mirrors codex-rs/rollout writer_lock.rs: coordination lock, then flock on <thread>.lock. */
export function acquireCodexWriterLock(home: string, threadId: string): CodexWriterLock {
    const directory = join(home, 'thread-writer-locks')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const coordination = acquireCoordination(directory)
    const path = join(directory, `${threadId}.lock`)
    let fd: number | undefined
    try {
        fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)
        const fn = loadFlock()
        const deadline = Date.now() + 1_000
        while (fn(fd, LOCK_EX | LOCK_NB) !== 0) {
            if (Date.now() >= deadline) throw new Error(`Thread ${threadId} already has an active Codex writer`)
            sleep(20)
        }
    } catch (error) {
        if (fd !== undefined) closeSync(fd)
        release(coordination); closeSync(coordination)
        throw error
    }
    release(coordination); closeSync(coordination)
    let released = false
    return {
        release() {
            if (released) return
            released = true
            if (fd !== undefined) { release(fd); closeSync(fd); fd = undefined }
            const coord = acquireCoordination(directory)
            try { unlinkSync(path) } catch { /* another Codex writer may have already cleaned it */ }
            release(coord); closeSync(coord)
        },
    }
}
