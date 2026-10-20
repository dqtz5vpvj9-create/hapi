import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'
import { createScopedGateway } from './scopedGateway'

type Configuration = { additionalScopes?: Array<{ machineId: string; root: string; sshHost: string; resolver: string }>; root: string; machineId: string; origin: string; accessToken: string; jwtSecret: string; ownerSettings: string; upstream: string; port: number; database: string }
const config: Configuration = JSON.parse(await readFile(process.env.HAPI_SHARE_CONFIG!, 'utf8'))
let ownerToken: string | undefined
let authenticating: Promise<string> | undefined
async function authenticate(): Promise<string> {
    if (!authenticating) authenticating = (async () => {
        const settings = JSON.parse(await readFile(config.ownerSettings, 'utf8'))
        const response = await fetch(`${config.upstream}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: settings.cliApiToken }) })
        if (!response.ok) throw new Error('Owner authentication unavailable')
        const data = await response.json() as { token: string }
        ownerToken = data.token
        return ownerToken
    })().finally(() => { authenticating = undefined })
    return authenticating
}
const app = await createScopedGateway({ ...config, database: new Database(config.database), jwtSecret: new TextEncoder().encode(config.jwtSecret),
    resolveRemotePath: async (machineId, path) => {
        const scope = config.additionalScopes?.find(scope => scope.machineId === machineId)
        if (!scope) throw new Error('Machine not shared')
        const { stdout } = await promisify(execFile)('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', scope.sshHost,
            'node.exe', scope.resolver, Buffer.from(path).toString('base64url')], { timeout: 20_000 })
        return JSON.parse(stdout) as { path: string; exists: boolean }
    },
    upstream: async (path, init) => {
        const request = async (token: string) => {
            const headers = new Headers(init?.headers)
            headers.set('Authorization', `Bearer ${token}`)
            headers.set('Accept-Encoding', 'identity')
            const response = await fetch(`${config.upstream}${path}`, { ...init, headers, redirect: 'error' })
            // Fetch decodes content encodings; a proxy must not forward their old headers.
            const responseHeaders = new Headers(response.headers)
            responseHeaders.delete('Content-Encoding')
            responseHeaders.delete('Content-Length')
            return new Response(response.body, { status: response.status, headers: responseHeaders })
        }
        const response = await request(ownerToken ?? await authenticate())
        return response.status === 401 ? request(await authenticate()) : response
    }
})
Bun.serve({ hostname: '127.0.0.1', port: config.port, fetch: app.fetch, idleTimeout: 0 })
console.log(`HAPI sharing gateway listening on 127.0.0.1:${config.port}`)
