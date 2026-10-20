import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CodexAccountSummary } from '@hapi/protocol/apiTypes'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'
import { resolveHapiHomeDir } from '@/configuration'
import { resolveCodexHome } from '@/codex/utils/codexHome'

type JsonRecord = Record<string, unknown>

type CodexAuthIdentity = {
    chatgptAccountId: string
    userId: string | null
    email: string | null
}

type StoredCodexAccount = CodexAccountSummary & {
    createdAt: number
    identityKey: string
}

type AccountRegistry = {
    version: 1
    accounts: StoredCodexAccount[]
}

const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60_000
const ACCOUNT_ID_PATTERN = /^codex_[0-9a-f]{24}$/

function assertAccountId(id: string): void {
    if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error('Invalid Codex account id')
}

function asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function decodeJwtClaims(token: string): JsonRecord {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) throw new Error('Codex identity token is invalid')
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JsonRecord
    } catch {
        throw new Error('Codex identity token claims are invalid')
    }
}

function authTokens(auth: JsonRecord): JsonRecord {
    const tokens = asRecord(auth.tokens)
    if (!tokens) throw new Error('Codex auth.json has no token bundle')
    for (const key of ['access_token', 'refresh_token', 'id_token'] as const) {
        if (!stringValue(tokens[key])) throw new Error(`Codex auth.json is missing ${key}`)
    }
    return tokens
}

export function readCodexAuthIdentity(auth: JsonRecord): CodexAuthIdentity {
    const tokens = authTokens(auth)
    const idToken = stringValue(tokens.id_token)!
    const claims = decodeJwtClaims(idToken)
    const authClaims = asRecord(claims['https://api.openai.com/auth'])
    const profileClaims = asRecord(claims['https://api.openai.com/profile'])
    const chatgptAccountId = stringValue(tokens.account_id)
        ?? stringValue(authClaims?.chatgpt_account_id)
    if (!chatgptAccountId) throw new Error('Codex login has no ChatGPT account id')
    return {
        chatgptAccountId,
        userId: stringValue(authClaims?.chatgpt_user_id),
        email: stringValue(claims.email) ?? stringValue(profileClaims?.email),
    }
}

function identityKey(identity: CodexAuthIdentity): string {
    return `${identity.chatgptAccountId}\u0000${identity.userId ?? identity.email?.toLowerCase() ?? ''}`
}

function accountIdFor(identity: CodexAuthIdentity): string {
    return `codex_${createHash('sha256').update(identityKey(identity)).digest('hex').slice(0, 24)}`
}

function parseLastRefresh(auth: JsonRecord): number | null {
    const raw = stringValue(auth.last_refresh)
    if (!raw) return null
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
}

function defaultLabel(identity: CodexAuthIdentity): string {
    return identity.email ?? identity.chatgptAccountId
}

function accountsRoot(): string {
    return join(resolveHapiHomeDir(), 'codex-accounts')
}

function registryPath(): string {
    return join(accountsRoot(), 'index.json')
}

function accountCredentialPath(accountId: string): string {
    assertAccountId(accountId)
    return join(accountsRoot(), 'credentials', `${accountId}.json`)
}

async function readJson(path: string): Promise<JsonRecord> {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    if (!record) throw new Error(`Invalid JSON document: ${path}`)
    return record
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
}

async function ensureRegistryFile(): Promise<void> {
    await mkdir(join(accountsRoot(), 'credentials'), { recursive: true, mode: 0o700 })
    try {
        await readFile(registryPath())
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writePrivateJson(registryPath(), { version: 1, accounts: [] })
    }
}

async function readRegistry(): Promise<AccountRegistry> {
    await ensureRegistryFile()
    const value = await readJson(registryPath())
    const accounts = Array.isArray(value.accounts) ? value.accounts : []
    return { version: 1, accounts: accounts as StoredCodexAccount[] }
}

async function mutateRegistry<T>(work: (registry: AccountRegistry) => Promise<T>): Promise<T> {
    await ensureRegistryFile()
    return await withSettingsFileLock(registryPath(), async () => {
        const registry = await readRegistry()
        const result = await work(registry)
        await writePrivateJson(registryPath(), registry)
        return result
    })
}

async function findCurrentAccountId(accounts: StoredCodexAccount[]): Promise<string | null> {
    try {
        const identity = readCodexAuthIdentity(await readJson(join(resolveCodexHome(), 'auth.json')))
        return accounts.find(account => account.identityKey === identityKey(identity))?.id ?? null
    } catch {
        return null
    }
}

export async function listCodexAccounts(): Promise<{
    accounts: CodexAccountSummary[]
    currentAccountId: string | null
}> {
    const registry = await readRegistry()
    return {
        accounts: registry.accounts.map(({ createdAt: _createdAt, identityKey: _identityKey, ...account }) => account),
        currentAccountId: await findCurrentAccountId(registry.accounts),
    }
}

export async function importCurrentCodexAccount(label?: string): Promise<CodexAccountSummary> {
    const sourceAuth = await readJson(join(resolveCodexHome(), 'auth.json'))
    return saveCodexAccountAuth(sourceAuth, label)
}

export async function saveCodexAccountAuth(sourceAuth: JsonRecord, label?: string): Promise<CodexAccountSummary> {
    const identity = readCodexAuthIdentity(sourceAuth)
    sourceAuth = { ...sourceAuth, tokens: { ...authTokens(sourceAuth), account_id: identity.chatgptAccountId } }
    const id = accountIdFor(identity)
    return await mutateRegistry(async registry => {
        const now = Date.now()
        const existing = registry.accounts.find(account => account.id === id)
        const next: StoredCodexAccount = {
            id,
            label: label?.trim() || existing?.label || defaultLabel(identity),
            email: identity.email,
            chatgptAccountId: identity.chatgptAccountId,
            enabled: existing?.enabled ?? true,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            lastRefreshAt: parseLastRefresh(sourceAuth),
            identityKey: identityKey(identity),
        }
        await writePrivateJson(accountCredentialPath(id), sourceAuth)
        const index = registry.accounts.findIndex(account => account.id === id)
        if (index >= 0) registry.accounts[index] = next
        else registry.accounts.push(next)
        const { createdAt: _createdAt, identityKey: _identityKey, ...summary } = next
        return summary
    })
}

export async function renameCodexAccount(id: string, label: string): Promise<CodexAccountSummary> {
    assertAccountId(id)
    return await mutateRegistry(async registry => {
        const account = registry.accounts.find(candidate => candidate.id === id)
        if (!account) throw new Error('Codex account not found')
        account.label = label.trim()
        account.updatedAt = Date.now()
        const { createdAt: _createdAt, identityKey: _identityKey, ...summary } = account
        return summary
    })
}

export async function deleteCodexAccount(id: string): Promise<void> {
    assertAccountId(id)
    await mutateRegistry(async registry => {
        const index = registry.accounts.findIndex(candidate => candidate.id === id)
        if (index < 0) throw new Error('Codex account not found')
        registry.accounts.splice(index, 1)
        await rm(accountCredentialPath(id), { force: true })
    })
}

function jwtExpiresAt(token: string): number | null {
    try {
        const exp = decodeJwtClaims(token).exp
        return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
    } catch {
        return null
    }
}

async function refreshedAuth(account: StoredCodexAccount, auth: JsonRecord): Promise<JsonRecord> {
    const tokens = authTokens(auth)
    const accessToken = stringValue(tokens.access_token)!
    const expiresAt = jwtExpiresAt(accessToken)
    if (expiresAt === null || expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS) return auth

    const refreshToken = stringValue(tokens.refresh_token)!
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
        scope: 'openid profile email',
    })
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Codex token refresh failed (${response.status})`)
    const payload = asRecord(await response.json())
    if (!payload || !stringValue(payload.access_token)) throw new Error('Codex token refresh returned no access token')
    const next: JsonRecord = {
        ...auth,
        tokens: {
            ...tokens,
            access_token: payload.access_token,
            refresh_token: stringValue(payload.refresh_token) ?? refreshToken,
            id_token: stringValue(payload.id_token) ?? tokens.id_token,
        },
        last_refresh: new Date().toISOString(),
    }
    const nextIdentity = readCodexAuthIdentity(next)
    if (identityKey(nextIdentity) !== account.identityKey) {
        throw new Error('Refreshed Codex token belongs to a different account')
    }
    return next
}

export async function loadFreshCodexAccount(id: string): Promise<{
    account: CodexAccountSummary
    auth: JsonRecord
}> {
    assertAccountId(id)
    // Codex may have rotated credentials since the account was saved. Import
    // its newer same-identity bundle before refreshing or activating a snapshot.
    await adoptRuntimeCodexAuth(id, resolveCodexHome())
    return await mutateRegistry(async registry => {
        const account = registry.accounts.find(candidate => candidate.id === id && candidate.enabled)
        if (!account) throw new Error('Codex account not found or disabled')
        const current = await readJson(accountCredentialPath(id))
        const auth = await refreshedAuth(account, current)
        if (auth !== current) {
            await writePrivateJson(accountCredentialPath(id), auth)
            account.updatedAt = Date.now()
            account.lastRefreshAt = parseLastRefresh(auth)
        }
        const { createdAt: _createdAt, identityKey: _identityKey, ...summary } = account
        return { account: summary, auth }
    })
}

export async function adoptRuntimeCodexAuth(id: string, home: string): Promise<boolean> {
    assertAccountId(id)
    let runtimeAuth: JsonRecord
    try {
        runtimeAuth = await readJson(join(home, 'auth.json'))
    } catch {
        return false
    }
    return await mutateRegistry(async registry => {
        const account = registry.accounts.find(candidate => candidate.id === id)
        if (!account) return false
        if (identityKey(readCodexAuthIdentity(runtimeAuth)) !== account.identityKey) return false
        const saved = await readJson(accountCredentialPath(id))
        const runtimeRefresh = parseLastRefresh(runtimeAuth) ?? 0
        const savedRefresh = parseLastRefresh(saved) ?? 0
        const runtimeToken = stringValue(authTokens(runtimeAuth).refresh_token)
        const savedToken = stringValue(authTokens(saved).refresh_token)
        if (runtimeToken === savedToken || runtimeRefresh <= savedRefresh) return false
        await writePrivateJson(accountCredentialPath(id), runtimeAuth)
        account.updatedAt = Date.now()
        account.lastRefreshAt = parseLastRefresh(runtimeAuth)
        return true
    })
}

/** Selects one stored identity without changing Codex's sole home directory. */
export async function activateCodexAccountForSpawn(id: string): Promise<{
    account: CodexAccountSummary
}> {
    const { account, auth } = await loadFreshCodexAccount(id)
    await writePrivateJson(join(resolveCodexHome(), 'auth.json'), auth)
    return { account }
}

export async function persistActiveCodexAccount(id: string, auth: JsonRecord): Promise<void> {
    await loadFreshCodexAccount(id)
    if (accountIdFor(readCodexAuthIdentity(auth)) !== id) {
        throw new Error('Codex runtime account identity did not match the selected account')
    }
    await writePrivateJson(join(resolveCodexHome(), 'auth.json'), auth)
}

/**
 * Extracts the provider account id returned by Codex app-server account/read.
 * Field variants follow the MIT-licensed Happier runtime adapter.
 */
export function readCodexLiveAccountId(value: unknown): string | null {
    const response = asRecord(value)
    const account = asRecord(response?.account)
    const auth = asRecord(response?.auth)
    const profile = asRecord(response?.profile)
    const values = [
        response?.chatgptAccountId, response?.chatgpt_account_id, response?.accountId, response?.account_id,
        account?.id, account?.accountId, account?.account_id, account?.chatgptAccountId, account?.chatgpt_account_id,
        auth?.account_id, auth?.accountId, auth?.chatgptAccountId, auth?.chatgpt_account_id,
        profile?.accountId, profile?.providerAccountId, profile?.account_id, profile?.chatgptAccountId,
        profile?.chatgpt_account_id, response?.id,
    ]
    for (const value of values) {
        const parsed = stringValue(value)
        if (parsed) return parsed
    }
    return null
}

export function activeCodexRuntimeAccountId(): string | null {
    return process.env.HAPI_CODEX_ACCOUNT_ID?.trim() || null
}

export function activeCodexRuntimeHome(): string {
    return resolveCodexHome()
}

