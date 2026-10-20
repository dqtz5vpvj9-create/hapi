/**
 * Real-DSH smoke for the injected subagent control channel.
 *
 * Launches the installed `dsh --profile acp` with the HAPI control patch,
 * creates one empty session, and exercises the three catalog/transcript
 * operations. It makes no model call and never prompts the agent, so the run
 * costs nothing beyond process startup.
 *
 *   DSH_HOME=/path/to/writable/home bun cli/scripts/smoke-dsh-subagents.ts
 *
 * A writable DSH_HOME with `profiles/acp` is required because the harness
 * sandbox keeps the real `~/.dsh` read-only. Copy the profile from the
 * installed home when running outside a sandbox.
 */
import { createDshBackend } from '../src/dsh/utils/dshBackend'
import { createDshControl } from '../src/dsh/utils/dshControl'

const cwd = process.argv[2] ?? process.cwd()
/** Optional durable child session to read instead of creating a fresh root. */
const transcriptSessionId = process.argv[3]
const control = await createDshControl()
const backend = createDshBackend({ ...process.env, ...control.env }, 'default', control.patch)
let root: string | undefined
try {
    await backend.initialize()
    if (transcriptSessionId) {
        // Tail window: the default read has no cursors.
        const head = await control.transcript(transcriptSessionId, { limit: 12 })
        const kinds = head.messages.reduce<Record<string, number>>((counts, message) => {
            const kind = message.kind ?? message.role
            counts[kind] = (counts[kind] ?? 0) + 1
            return counts
        }, {})
        console.log(`[smoke] tail window: ${head.messages.length} messages kinds=${JSON.stringify(kinds)} epoch=${head.epoch}`)
        if (head.epoch.length === 0) throw new Error('transcript returned an empty epoch')
        if (head.messages.length === 0) throw new Error('transcript returned no messages')
        if (head.after < head.messages.length) throw new Error(`unexpected forward cursor ${head.after}`)
        if (head.hasMore && head.before === null) throw new Error('tail page claims more history without a cursor')
        // Forward paging from the beginning must deliver an ordered prefix.
        const first = await control.transcript(transcriptSessionId, { limit: 5, after: 0, epoch: head.epoch })
        if (first.messages.length === 0) throw new Error('forward page came back empty')
        if (first.after !== first.messages.length) throw new Error(`unexpected forward cursor ${first.after}`)
        const next = await control.transcript(transcriptSessionId, { limit: 5, after: first.after, epoch: first.epoch })
        if (next.messages.some(message => first.messages.some(seen => seen.id === message.id))) {
            throw new Error('forward paging repeated an earlier message')
        }
        console.log(`[smoke] forward pages: ${first.messages.length}+${next.messages.length} messages, hasLater=${next.hasLater}`)
        // Backward paging from the tail must expose rows older than the tail window.
        if (head.hasMore) {
            const older = await control.transcript(transcriptSessionId, { limit: 5, before: head.before! })
            if (older.messages.length === 0) throw new Error('older page came back empty')
            if (older.messages.some(message => head.messages.some(seen => seen.id === message.id))) {
                throw new Error('backward paging repeated a tail message')
            }
            console.log(`[smoke] older page: ${older.messages.length} messages, hasMore=${older.hasMore}`)
        }
        console.log('[smoke] ok')
    } else {
    root = await backend.newSession({ cwd, mcpServers: [] })
    console.log(`[smoke] root session: ${root}`)
    await control.claimRoot(root)
    const children = await control.subagents(root)
    console.log(`[smoke] catalog children: ${JSON.stringify(children)}`)
    const page = await control.transcript(root, { limit: 20 })
    console.log(`[smoke] transcript epoch=${page.epoch} messages=${page.messages.length} before=${page.before} after=${page.after}`)
    console.log(`[smoke] first messages: ${JSON.stringify(page.messages.slice(0, 3))}`)
    if (page.epoch.length === 0) throw new Error('transcript returned an empty epoch')
    if (!Number.isInteger(page.after)) throw new Error('transcript returned no forward cursor')
    // The follow-up and interrupt services must be mounted even on an empty
    // catalog; an absent child is rejected by DSH itself, not by a missing service.
    for (const [label, run] of [
        ['prompt', () => control.prompt(root!, 'session-does-not-exist', 'ping', { delivery: 'queue', requestId: `smoke-${Date.now()}` })],
        ['interrupt', () => control.interrupt(root!, 'session-does-not-exist')],
    ] as const) {
        try {
            await run()
            console.log(`[smoke] ${label}: accepted (no live child)`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.log(`[smoke] ${label}: rejected as expected -> ${message}`)
            if (!message || message.includes('does not mount')) throw error
        }
    }
    }
} finally {
    try { if (root) await backend.closeSession?.(root) } catch { /* best effort */ }
    await backend.disconnect()
    await control.dispose()
}
console.log('[smoke] ok')
