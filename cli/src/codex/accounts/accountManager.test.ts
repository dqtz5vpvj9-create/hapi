import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
    activateCodexAccountForSpawn,
    importCurrentCodexAccount,
    listCodexAccounts,
    loadFreshCodexAccount,
} from './accountManager'

function jwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

function auth(accountId: string, email: string, suffix: string) {
    const claims = {
        exp: Math.floor(Date.now() / 1000) + 3600,
        email,
        'https://api.openai.com/auth': {
            chatgpt_account_id: accountId,
            chatgpt_user_id: `user-${suffix}`,
        },
    }
    return {
        tokens: {
            access_token: jwt(claims),
            refresh_token: `refresh-${suffix}`,
            id_token: jwt(claims),
            account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
    }
}

describe('Codex account manager', () => {
    let root: string
    let previousHapiHome: string | undefined
    let previousCodexHome: string | undefined

    beforeEach(async () => {
        root = join('/mnt/cache/data-cache', `hapi-codex-accounts-${randomUUID()}`)
        previousHapiHome = process.env.HAPI_HOME
        previousCodexHome = process.env.CODEX_HOME
        process.env.HAPI_HOME = join(root, 'hapi')
        process.env.CODEX_HOME = join(root, 'codex')
        await mkdir(process.env.CODEX_HOME, { recursive: true })
    })

    afterEach(async () => {
        if (previousHapiHome === undefined) delete process.env.HAPI_HOME
        else process.env.HAPI_HOME = previousHapiHome
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = previousCodexHome
        await rm(root, { recursive: true, force: true })
    })

    it('stores credentials separately while keeping one Codex home and history', async () => {
        const codexHome = process.env.CODEX_HOME!
        const history = join(codexHome, 'history.jsonl')
        await writeFile(history, '{"session":"kept"}\n')

        await writeFile(join(codexHome, 'auth.json'), JSON.stringify(auth('acct-a', 'a@example.com', 'a')))
        const accountA = await importCurrentCodexAccount('Account A')
        await writeFile(join(codexHome, 'auth.json'), JSON.stringify(auth('acct-b', 'b@example.com', 'b')))
        const accountB = await importCurrentCodexAccount('Account B')

        expect(accountA.id).not.toBe(accountB.id)
        await activateCodexAccountForSpawn(accountA.id)
        expect((await loadFreshCodexAccount(accountA.id)).account.label).toBe('Account A')
        expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).tokens.account_id).toBe('acct-a')
        expect(await readFile(history, 'utf8')).toBe('{"session":"kept"}\n')
        await expect(stat(join(process.env.HAPI_HOME!, 'codex-accounts', 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('preserves newer runtime credentials when spawning the same stored account', async () => {
        const path = join(process.env.CODEX_HOME!, 'auth.json')
        const old = { ...auth('acct-a', 'a@example.com', 'a'), last_refresh: '2026-01-01T00:00:00Z' }
        await writeFile(path, JSON.stringify(old))
        const saved = await importCurrentCodexAccount()
        const current = { ...old, tokens: { ...old.tokens, refresh_token: 'rotated' }, last_refresh: '2026-02-01T00:00:00Z' }
        await writeFile(path, JSON.stringify(current))
        await activateCodexAccountForSpawn(saved.id)
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(current)
        expect((await loadFreshCodexAccount(saved.id)).auth).toEqual(current)
    })

    it('keeps secrets out of the account index', async () => {
        await writeFile(join(process.env.CODEX_HOME!, 'auth.json'), JSON.stringify(auth('acct-a', 'a@example.com', 'a')))
        const imported = await importCurrentCodexAccount()
        const listed = await listCodexAccounts()
        expect(listed.accounts).toHaveLength(1)
        expect(listed.currentAccountId).toBe(imported.id)
        const index = await readFile(join(process.env.HAPI_HOME!, 'codex-accounts', 'index.json'), 'utf8')
        expect(index).not.toContain('refresh-a')
        expect(index).not.toContain('access_token')
    })
})
