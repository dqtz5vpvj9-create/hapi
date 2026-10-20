/**
 * Real end-to-end smoke for DSH subagent control (spawn -> catalog -> read ->
 * continue -> interrupt). It launches the installed `dsh --profile acp` with
 * the HAPI control patch, lets a REAL model call `spawn_teammate`, and verifies
 * the control channel against the live DSH process.
 *
 *   HAPI_HOME=/writable/control/home bun cli/scripts/smoke-dsh-subagent-spawn.ts [cwd]
 *
 * Uses the ambient DSH_HOME so the installed profile and model credentials
 * apply. It creates two real DSH sessions (root + teammate); remove them from
 * the DSH store afterwards when they are no longer useful.
 */
import { createDshBackend } from '../src/dsh/utils/dshBackend'
import { createDshControl, type DshControlSubagent, type DshControlTranscriptPage } from '../src/dsh/utils/dshControl'

const cwd = process.argv[2] ?? process.cwd()
const TEAMMATE = 'smoke-ajax'
const control = await createDshControl()
const backend = createDshBackend({ ...process.env, ...control.env }, 'default', control.patch)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let root: string | undefined

async function waitFor<T>(label: string, timeoutMs: number, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let last: T | undefined
    while (Date.now() < deadline) {
        last = await read()
        if (last !== undefined) return last
        await sleep(250)
    }
    throw new Error(`[e2e] timed out waiting for ${label}`)
}

const roles = (page: DshControlTranscriptPage) => page.messages.reduce<Record<string, number>>((counts, message) => {
    const key = `${message.role}/${message.kind ?? 'message'}`
    counts[key] = (counts[key] ?? 0) + 1
    return counts
}, {})

try {
    await backend.initialize()
    root = await backend.newSession({ cwd, mcpServers: [] })
    console.log(`[e2e] root session: ${root}`)
    await control.claimRoot(root)

    const task = [
        'Use the spawn_teammate tool exactly once:',
        `- name: "${TEAMMATE}"`,
        '- task: "Use the bash tool to run `sleep 4`, then reply with the single word PONG and nothing else. Do not use any other tools."',
        'Then call wait_agent once with a 60 second timeout and reply with one short sentence summarizing the teammate result.',
        'Do not create additional teammates and do not use any other tools.'
    ].join('\n')
    const turn = backend.prompt(root, [{ type: 'text', text: task }], message => {
        if (message && message.type === 'text' && message.text.trim()) process.stdout.write('.')
    })
    let sawRunning = false
    let children: DshControlSubagent[] = []
    try {
        children = await waitFor('spawned child catalog', 180_000, async () => {
            const current = await control.subagents(root!)
            if (current.some(child => child.activity === 'running' || child.teamStatus === 'running')) sawRunning = true
            return current.length > 0 ? current : undefined
        })
    } finally {
        await turn
        await backend.waitForResponseComplete()
    }
    console.log(`\n[e2e] catalog: ${JSON.stringify(children)}`)
    if (!sawRunning) throw new Error('[e2e] never observed a running child in the catalog')
    const child = children.find(candidate => candidate.mode === 'continuable') ?? children[0]!
    if (child.mode !== 'continuable') throw new Error(`[e2e] expected a continuable child, got ${child.mode}`)

    const firstPage = await waitFor('child transcript', 30_000, async () => {
        const page = await control.transcript(child.sessionId, { limit: 50 })
        return page.messages.length > 0 ? page : undefined
    })
    console.log(`[e2e] child transcript: ${firstPage.messages.length} messages ${JSON.stringify(roles(firstPage))}`)
    if (!firstPage.messages.some(message => message.role === 'user')) throw new Error('[e2e] child transcript has no user prompt')
    if (!firstPage.messages.some(message => message.role === 'assistant')) throw new Error('[e2e] child transcript has no assistant reply')
    const pong = firstPage.messages.some(message => message.role === 'assistant' && /PONG/i.test(message.text))
    console.log(`[e2e] teammate answered PONG: ${pong}`)

    await control.prompt(root, child.sessionId, 'Reply with the single word PONG2 and nothing else.', {
        delivery: 'queue',
        requestId: `e2e-${Date.now().toString(36)}`
    })
    console.log('[e2e] follow-up accepted by the teammate inbox')
    const continued = await waitFor('follow-up answer', 180_000, async () => {
        const page = await control.transcript(child.sessionId, { limit: 50 })
        return page.messages.some(message => message.role === 'assistant' && /PONG2/i.test(message.text)) ? page : undefined
    })
    console.log(`[e2e] follow-up answered: ${continued.messages.length} messages ${JSON.stringify(roles(continued))}`)
    if (!continued.messages.some(message => message.role === 'user' && /PONG2/i.test(message.text))) {
        throw new Error('[e2e] follow-up user message missing from the transcript')
    }

    const stop = await control.interrupt(root, child.sessionId)
    console.log(`[e2e] interrupt on an idle child: ${JSON.stringify(stop)}`)
    if (stop.accepted !== true) throw new Error('[e2e] interrupt was not accepted')

    const afterStop = await control.subagents(root)
    console.log(`[e2e] final catalog: ${JSON.stringify(afterStop)}`)
    console.log('[e2e] ok')
} finally {
    try { if (root) await backend.closeSession?.(root) } catch { /* best effort */ }
    await backend.disconnect()
    await control.dispose()
}
