#!/usr/bin/env node
/** Capture a bounded, private history slice. Does not send or import messages. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals: ids } = parseArgs({
    options: {
        url: { type: 'string', default: 'http://127.0.0.1:3006' },
        output: { type: 'string' },
        rows: { type: 'string', default: '2000' },
        pages: { type: 'string', default: '60' },
        dependencies: { type: 'boolean', default: false },
    },
    allowPositionals: true,
})
if (!values.output || !ids.length || !process.env.CLI_API_TOKEN) {
    throw new Error('Provide --output outside the repository, session UUIDs, and CLI_API_TOKEN in the environment')
}
const root = path.resolve(values.output)
await fs.mkdir(root, { recursive: true, mode: 0o700 })
const write = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value), { mode: 0o600 })
const authResponse = await fetch(new URL('/api/auth', values.url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: process.env.CLI_API_TOKEN }),
})
if (!authResponse.ok) throw new Error(`Authentication failed: ${authResponse.status}`)
const { token } = await authResponse.json()
const get = resource => fetch(new URL(resource, values.url), { headers: { authorization: `Bearer ${token}` } })
const json = async resource => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await get(resource)
        if (response.ok) return response.json()
        // Record real metadata unavailability instead of silently replacing it
        // with an empty page. Tokens and message bodies never enter this log.
        await fs.appendFile(path.join(root, 'capture-errors.log'), `${response.status} ${resource}\n`, { mode: 0o600 })
        if (response.status !== 503 || attempt === 2) throw new Error(`Capture failed: ${response.status} ${resource}`)
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
}
const list = await json('/api/sessions')
await write('session-list.json', { ...list, sessions: list.sessions.filter(session => ids.includes(session.id)) })
const auxiliary = {}, media = {}, unavailable = []
const auxiliaryPaths = new Set(['/api/hub-settings', '/api/machines', '/api/voice/transcription/providers', '/api/voice/backend'])
let mediaIndex = 0
for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Expected HAPI session UUID')
    const session = await json(`/api/sessions/${id}`)
    const pages = [], unique = new Set()
    let cursor, epoch
    for (let index = 0; index < Number(values.pages) && unique.size < Number(values.rows); index++) {
        const query = new URLSearchParams({ limit: index === 0 ? '20' : '200' })
        if (cursor) {
            query.set('beforeAt', String(cursor.at)); query.set('beforeSeq', String(cursor.seq)); query.set('epoch', String(epoch))
        }
        const page = await json(`/api/sessions/${id}/messages?${query}`)
        if (epoch !== undefined && page.page.epoch !== epoch) throw new Error('History epoch changed during capture; recapture into a new directory')
        pages.push(page)
        for (const row of page.messages) unique.add(row.id)
        await write(`${id}.json`, { session, pages })
        epoch = page.page.epoch
        const next = page.page.nextBeforeSeq == null ? null : { at: page.page.nextBeforeAt, seq: page.page.nextBeforeSeq }
        if (!page.page.hasMore || !next) break
        if (cursor && cursor.at === next.at && cursor.seq === next.seq) throw new Error('History cursor made no progress')
        cursor = next
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    console.log(JSON.stringify({ id, pages: pages.length, messages: unique.size, truncated: pages.at(-1)?.page.hasMore }))
    if (values.dependencies) {
        // Capture the exact requests made when opening initial-page tool details.
        // Keep their epoch with the transcript; a later live response is not a
        // valid substitute for a frozen history dependency.
        for (const row of pages[0].messages) {
            const query = new URLSearchParams({ seeds: row.id, epoch: String(epoch) })
            const resource = `/api/sessions/${id}/messages/dependencies?${query}`
            const response = await get(resource)
            const body = await response.json()
            if (response.ok && (body.reset || body.epoch !== epoch)) {
                throw new Error('Dependency epoch changed during capture; recapture into a new directory')
            }
            auxiliary[resource] = { status: response.status, body }
        }
    }
    for (const suffix of ['skills', 'slash-commands', 'scratchlist']) auxiliaryPaths.add(`/api/sessions/${id}/${suffix}`)
    const machine = session.session.metadata?.machineId
    if (machine) auxiliaryPaths.add(`/api/machines/${machine}/codex-models`)
    const artifacts = new Map()
    function visit(value) {
        if (!value || typeof value !== 'object') return
        if (value.artifact?.id) artifacts.set(value.artifact.id, value.artifact)
        for (const child of Object.values(value)) visit(child)
    }
    visit(pages)
    for (const artifact of artifacts.values()) {
        const resource = `/api/sessions/${id}/artifacts/${encodeURIComponent(artifact.id)}`
        const response = await get(resource)
        if (!response.ok) { unavailable.push({ resource, status: response.status }); continue }
        const file = `media-${++mediaIndex}.bin`
        await fs.writeFile(path.join(root, file), Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
        media[decodeURIComponent(resource)] = { file, type: response.headers.get('content-type') || artifact.mimeType }
    }
}
for (const resource of auxiliaryPaths) {
    const response = await get(resource)
    auxiliary[resource] = { status: response.status, body: await response.json() }
}
await write('media.json', media)
await write('unavailable-media.json', unavailable)
await write('aux.json', auxiliary)
