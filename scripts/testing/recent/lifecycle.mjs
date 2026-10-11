import { spawn } from 'node:child_process'

// Attach settlement listeners in the same synchronous turn as spawn, before
// status I/O. Only this invocation's detached positive process-group ID is killed.
export async function runOwnedChild(command, args, options, {
    onSpawn = async () => {}, timeoutMs = 22000, graceMs = 2500,
    spawnChild = spawn, kill = process.kill.bind(process), signals = process,
} = {}) {
    const child = spawnChild(command, args, { ...options, detached: true })
    const exited = new Promise(resolve => {
        child.once('exit', (code, signal) => resolve({ code: code ?? 130, signal }))
        child.once('error', error => resolve({ code: 1, error: String(error) }))
    })
    const ownedGroup = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null
    const terminate = signal => { if (ownedGroup !== null) { try { kill(-ownedGroup, signal) } catch {} } }
    let timedOut = false, interrupted = false, stopping = false, forceTimer
    const stop = () => {
        if (stopping) return
        stopping = true
        terminate('SIGTERM')
        forceTimer = setTimeout(() => terminate('SIGKILL'), graceMs)
    }
    const interrupt = () => { interrupted = true; stop() }
    signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt)
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    try {
        await onSpawn(child)
        const result = await exited
        return { ...result, code: timedOut || interrupted ? (result.code || 130) : result.code, timedOut, interrupted }
    } finally {
        clearTimeout(timer); clearTimeout(forceTimer)
        signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt)
        terminate('SIGKILL')
    }
}

export async function recordRun(status, save, work, cleanup) {
    status.code = 0
    try { await save(); await work() }
    catch (error) { status.code ||= 1; status.failure = String(error) }
    finally {
        try { await cleanup() }
        catch (error) { status.code ||= 1; status.cleanupFailure = String(error) }
        status.status = 'terminal'; status.endedAt = new Date().toISOString()
        try { await save() }
        catch (error) { status.code ||= 1; status.receiptFailure = String(error); console.error('Cannot save terminal status:', String(error)) }
    }
    return status.code
}
