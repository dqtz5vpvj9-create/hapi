import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws-node'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { MachineTerminalCommandSchema, type MachineTerminalResponse } from '@hapi/protocol/terminals'
import { TerminalHost } from './TerminalHost'
import { lockTerminalHost } from './hostProcessLock'

export type TerminalHostAddress = { version: 1; url: string; token: string; pid: number; instanceId: string }
const requestSchema = z.object({ requestId: z.string().min(1).max(128), command: MachineTerminalCommandSchema }).strict()

export async function startTerminalHost(options: { directory: string; workspaceRoots?: readonly string[]; shell?: string[]; outputBytes?: number; scrollback?: number }) {
    await mkdir(options.directory, { recursive: true, mode: 0o700 })
    // This directory contains the credential granting access to live shells.
    // POSIX mode bits alone do not restrict inherited Windows ACLs on D:\hapi.
    if (process.platform === 'win32') {
        const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim()
        execFileSync('icacls.exe', [options.directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true })
    } else await chmod(options.directory, 0o700)
    const release = await lockTerminalHost(join(options.directory, 'host.lock'))
    const token = randomUUID(), instanceId = randomUUID()
    const expected = Buffer.from(`Bearer ${token}`)
    const authorized = (header: string | undefined) => { const given = Buffer.from(header ?? ''); return given.length === expected.length && timingSafeEqual(given, expected) }
    let host: TerminalHost
    try { host = new TerminalHost(options) } catch (error) { await release(); throw error }
    const server = createServer((request, response) => {
        if (!authorized(request.headers.authorization) || request.headers.origin) { response.writeHead(401); response.end(); return }
        if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404); response.end(); return }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ instanceId, pid: process.pid }))
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
    server.on('upgrade', (request, socket, head) => {
        if (request.url !== '/events' || !authorized(request.headers.authorization) || request.headers.origin) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return
        }
        wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
    })
    wss.on('connection', ws => {
        const peer = randomUUID(), subscriptions = new Set<string>()
        const send = (value: unknown) => {
            if (ws.readyState !== WebSocket.OPEN) return
            // A slow viewer reconnects to the authoritative screen instead of
            // retaining an unbounded output queue in the terminal owner.
            if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Output consumer is behind; reattach'); return }
            ws.send(JSON.stringify(value))
        }
        const unsubscribe = host.subscribe(event => {
            if (event.type === 'state' || subscriptions.has(event.terminalId)) send({ event })
        })
        let pending = Promise.resolve()
        ws.on('message', data => {
            let value: unknown
            try { value = JSON.parse(data.toString()) } catch { ws.close(1008, 'Invalid request'); return }
            const parsed = requestSchema.safeParse(value)
            if (!parsed.success) { ws.close(1008, 'Invalid request'); return }
            const { requestId, command } = parsed.data
            pending = pending.then(async () => {
                if (ws.readyState !== WebSocket.OPEN) return
                if (command.type === 'attach') subscriptions.add(command.terminalId)
                if (command.type === 'detach') subscriptions.delete(command.terminalId)
                let response: MachineTerminalResponse
                try { response = { requestId, ok: true, value: await host.execute(peer, command) } }
                catch (error) { response = { requestId, ok: false, error: error instanceof Error ? error.message : 'Terminal request failed' } }
                // A claim resolving after transport loss must not retain control.
                if (ws.readyState !== WebSocket.OPEN) host.releasePeer(peer)
                send(response)
            })
        })
        ws.on('close', () => { unsubscribe(); host.releasePeer(peer) })
        ws.on('error', () => ws.terminate())
    })
    try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
        const port = (server.address() as { port: number }).port
        const address: TerminalHostAddress = { version: 1, url: `http://127.0.0.1:${port}`, token, pid: process.pid, instanceId }
        const path = join(options.directory, 'connection.json')
        await writeFile(path + '.next', JSON.stringify(address), { mode: 0o600 })
        await rename(path + '.next', path)
        return { host, address, async stop() {
            for (const ws of wss.clients) ws.terminate()
            wss.close()
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            await host.stop()
            await unlink(path)
            await release()
        } }
    } catch (error) {
        wss.close(); server.close(); await host.stop(); await release(); throw error
    }
}
