import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAgentAvailability } from '@/agent/agentAvailability'
import { createDshBackend, resolveDshAcpCommand } from './dshBackend'

describe('resolveDshAcpCommand', () => {
    it('starts the official dsh executable in its ACP profile by default', () => {
        expect(resolveDshAcpCommand({})).toEqual({
            command: 'dsh',
            args: ['--profile', 'acp']
        })
    })

    it('applies an optional patch to the official ACP profile', () => {
        expect(resolveDshAcpCommand({ HAPI_DSH_ACP_CONFIG: '/tmp/cordis.yml' })).toEqual({
            command: 'dsh',
            args: ['--profile', 'acp', '--patch', '/tmp/cordis.yml']
        })
    })

    it.each(['dsh', '/opt/deepseek/bin/dsh', 'C:\\DeepSeek\\dsh.exe', 'C:\\DeepSeek\\dsh.cmd'])('keeps an explicit official executable in ACP mode: %s', (command) => {
        expect(resolveDshAcpCommand({ HAPI_DSH_ACP_COMMAND: command })).toEqual({
            command,
            args: ['--profile', 'acp']
        })
    })

    it('preserves the argument contract of explicit custom ACP servers', () => {
        expect(resolveDshAcpCommand({ HAPI_DSH_ACP_COMMAND: '/opt/community/acp-server' })).toEqual({
            command: '/opt/community/acp-server',
            args: []
        })
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_COMMAND: 'dsh-acp-demo',
            HAPI_DSH_ACP_CONFIG: '/tmp/cordis.yml'
        })).toEqual({
            command: 'dsh-acp-demo',
            args: ['--config', '/tmp/cordis.yml']
        })
    })

    it('supports source checkouts and community servers through JSON args', () => {
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_COMMAND: 'pnpm',
            HAPI_DSH_ACP_ARGS_JSON: '["--dir", "/opt/dsh", "run", "dsh", "--profile", "acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/dsh', 'run', 'dsh', '--profile', 'acp']
        })
    })

    it('keeps explicit JSON arguments unchanged instead of adding a profile or config', () => {
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_ARGS_JSON: '["--profile", "my-acp"]',
            HAPI_DSH_ACP_CONFIG: '/ignored/cordis.yml'
        })).toEqual({ command: 'dsh', args: ['--profile', 'my-acp'] })
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_COMMAND: '/opt/community/acp-server',
            HAPI_DSH_ACP_ARGS_JSON: '[]',
            HAPI_DSH_ACP_CONFIG: '/ignored/cordis.yml'
        })).toEqual({ command: '/opt/community/acp-server', args: [] })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveDshAcpCommand({ HAPI_DSH_ACP_ARGS_JSON: 'pnpm --dir /opt/dsh' }))
            .toThrow('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveDshAcpCommand({ HAPI_DSH_ACP_ARGS_JSON: '["pnpm", 1]' }))
            .toThrow('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    })
})

describe('DSH executable and ACP transport', () => {
    it('discovers a dsh-only installation and passes ACP arguments to a real stdio child', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-dsh-launch-'))
        const recordPath = join(directory, 'requests.json')
        const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const requests = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    requests.push(request);
    fs.writeFileSync(process.env.DSH_TEST_RECORD, JSON.stringify({ args: process.argv.slice(2), requests }));
    const result = request.method === 'initialize'
        ? { protocolVersion: 1, agentCapabilities: {} }
        : request.method === 'session/new' ? { sessionId: 'dsh-transport-session' } : null;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`
        const executable = join(directory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
        if (process.platform === 'win32') {
            const peer = join(directory, 'peer.cjs')
            await writeFile(peer, script)
            await writeFile(executable, `@echo off\r\n"${process.execPath}" "${peer}" %*\r\n`)
        } else {
            await writeFile(executable, `#!${process.execPath}\n${script}`)
            await chmod(executable, 0o755)
        }
        const env: NodeJS.ProcessEnv = {
            PATH: `${directory}${delimiter}${dirname(process.execPath)}`,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            DSH_TEST_RECORD: recordPath
        }
        const backend = createDshBackend(env)
        try {
            expect(getAgentAvailability('dsh', env)).toEqual({ agent: 'dsh', available: true })
            await backend.initialize()
            expect(await backend.newSession({ cwd: directory, mcpServers: [] })).toBe('dsh-transport-session')
            expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
                args: ['--profile', 'acp'],
                requests: [
                    { method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'hapi' } } },
                    { method: 'session/new', params: { cwd: directory, mcpServers: [] } }
                ]
            })
        } finally {
            await backend.disconnect()
            await rm(directory, { recursive: true, force: true })
        }
    })
})
