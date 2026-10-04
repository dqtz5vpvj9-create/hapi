import { closeSync, fstatSync, openSync, readSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { isCodexSubagentSource } from '@/codex/utils/codexSessionMetadata'

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 200

type CodexSessionIndexTitle = {
    threadName: string
    updatedAt: string
}

type CodexImportedMessageContent = {
    role: 'user'
    content: { type: 'text'; text: string }
    meta: { sentFrom: 'cli' }
} | {
    role: 'agent'
    content: { type: typeof AGENT_MESSAGE_PAYLOAD_TYPE; data: unknown }
    meta: { sentFrom: 'cli' }
}

export type LocalCodexSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    source?: string | null
    threadSource?: string | null
    forkedFromId?: string | null
}

export type LocalCodexSessionWithMessages = LocalCodexSessionSummary & {
    messages: CodexImportedMessageContent[]
}

export type ArchiveLocalCodexSessionOptions = {
    canArchive?: (session: LocalCodexSessionSummary) => boolean | Promise<boolean>
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        return value.map((item) => {
            const record = asRecord(item)
            if (record?.type === 'text' && typeof record.text === 'string') return record.text
            if (record?.type === 'input_text' && typeof record.text === 'string') return record.text
            if (record?.type === 'output_text' && typeof record.text === 'string') return record.text
            return null
        }).filter((part): part is string => Boolean(part)).join(' ').trim()
    }
    const record = asRecord(value)
    if (record?.type === 'text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'input_text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'output_text' && typeof record.text === 'string') return record.text.trim()
    return ''
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function shouldIgnoreSyntheticUserMessage(text: string): boolean {
    const normalized = text.trim()
    return normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')
}

function inferSessionIdFromFileName(filePath: string): string | null {
    return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(filePath)?.[1] ?? null
}

function collectJsonlFiles(root: string, files: string[]): void {
    let entries: import('node:fs').Dirent[]
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) collectJsonlFiles(fullPath, files)
        else if (entry.isFile() && fullPath.toLowerCase().endsWith('.jsonl')) files.push(fullPath)
    }
}

function getCodexHome(): string {
    return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

function getCodexSessionRoots(): string[] {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    return [join(codexHome, 'sessions')]
}

function getCodexSessionIndexPath(): string {
    return join(getCodexHome(), 'session_index.jsonl')
}

function readCodexSessionIndexTitles(): Map<string, CodexSessionIndexTitle> {
    let content: string
    try {
        content = readFileSync(getCodexSessionIndexPath(), 'utf-8')
    } catch {
        return new Map()
    }

    const titles = new Map<string, CodexSessionIndexTitle>()
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
        try {
            const record = asRecord(JSON.parse(line))
            const id = typeof record?.id === 'string' ? record.id : null
            const threadName = typeof record?.thread_name === 'string' && record.thread_name.trim()
                ? record.thread_name.trim()
                : null
            const updatedAt = typeof record?.updated_at === 'string' && record.updated_at.trim()
                ? record.updated_at.trim()
                : null
            if (!id || !threadName || !updatedAt) continue

            const previous = titles.get(id)
            if (!previous || previous.updatedAt < updatedAt) {
                titles.set(id, { threadName, updatedAt })
            }
        } catch {
            continue
        }
    }
    return titles
}

function extractCodexChangedTitle(record: Record<string, unknown>): string | null {
    if (record.type === 'response_item') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'function_call' && payload.name === 'change_title' && typeof payload.arguments === 'string') {
            try {
                const parsed = JSON.parse(payload.arguments) as { title?: unknown }
                return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
            } catch { return null }
        }
    }
    if (record.type === 'event_msg') {
        const payload = asRecord(record.payload)
        const invocation = asRecord(payload?.invocation)
        const args = asRecord(invocation?.arguments)
        if (payload?.type === 'mcp_tool_call_end' && invocation?.tool === 'change_title' && typeof args?.title === 'string' && args.title.trim()) {
            return args.title.trim()
        }
    }
    return null
}

function getLatestCodexChangedTitle(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record) continue
            const title = extractCodexChangedTitle(record)
            if (title) return title
        } catch { continue }
    }
    return null
}

function getLatestCodexUserMessage(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record || record.type !== 'response_item') continue
            const payload = asRecord(record.payload)
            if (payload?.type !== 'message' || payload.role !== 'user') continue
            const text = extractCodexText(payload.content)
            if (text && !shouldIgnoreSyntheticUserMessage(text)) return truncateText(text, 140)
        } catch { continue }
    }
    return null
}

function getCodexSessionTitle(cwd: string | null | undefined, sessionId: string, sessionIndexTitle: string | null, changedTitle: string | null, firstUserMessage: string | null): string {
    if (sessionIndexTitle) return truncateText(sessionIndexTitle, 80)
    if (changedTitle) return changedTitle
    if (firstUserMessage) return truncateText(firstUserMessage, 80)
    if (cwd) return basename(cwd) || cwd
    return sessionId.slice(0, 8)
}

function parseCodexFunctionArguments(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
    try { return JSON.parse(trimmed) } catch { return value }
}

function extractCodexToolCallId(payload: Record<string, unknown>): string | null {
    for (const key of ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id']) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function buildImportedUserMessage(text: string): CodexImportedMessageContent {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }
}

function buildImportedAgentMessage(data: unknown): CodexImportedMessageContent {
    return { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data }, meta: { sentFrom: 'cli' } }
}

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageContent | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) return null
    if (type === 'event_msg') {
        const eventType = asString(payload.type)
        if (eventType === 'user_message') {
            const text = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content)
            return text && !shouldIgnoreSyntheticUserMessage(text) ? buildImportedUserMessage(text) : null
        }
        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'message', message, id: randomUUID() }) : null
        }
        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info ? buildImportedAgentMessage({ type: 'token_count', info, id: randomUUID() }) : null
        }
        return null
    }
    if (type !== 'response_item') return null
    const itemType = asString(payload.type)
    if (itemType === 'message') {
        const role = asString(payload.role)
        const text = extractCodexText(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        if (role === 'user') return buildImportedUserMessage(text)
        if (role === 'assistant') return buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() })
    }
    if (itemType === 'function_call') {
        const name = asString(payload.name)
        const callId = extractCodexToolCallId(payload)
        return name && callId ? buildImportedAgentMessage({ type: 'tool-call', name, callId, input: parseCodexFunctionArguments(payload.arguments), id: randomUUID() }) : null
    }
    if (itemType === 'function_call_output') {
        const callId = extractCodexToolCallId(payload)
        return callId ? buildImportedAgentMessage({ type: 'tool-call-result', callId, output: payload.output, id: randomUUID() }) : null
    }
    return null
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function normalizeComparableContent(content: unknown): string | null {
    const record = asRecord(content)
    if (!record) return null
    if (record.role === 'user') {
        const body = asRecord(record.content)
        return body?.type === 'text' && typeof body.text === 'string'
            ? stableSerialize({ role: 'user', text: body.text.replace(/\s+$/u, '') })
            : null
    }
    if (record.role === 'agent') {
        const body = asRecord(record.content)
        const data = asRecord(body?.data)
        const normalized = data ? { ...data } : body?.data
        if (data) delete (normalized as Record<string, unknown>).id
        return body?.type === AGENT_MESSAGE_PAYLOAD_TYPE ? stableSerialize({ role: 'agent', data: normalized }) : null
    }
    return null
}

function deduplicateAdjacentImportedMessages(messages: CodexImportedMessageContent[]): CodexImportedMessageContent[] {
    const deduped: CodexImportedMessageContent[] = []
    let previousKey: string | null = null
    for (const message of messages) {
        const key = normalizeComparableContent(message)
        if (key && key === previousKey) continue
        deduped.push(message)
        previousKey = key
    }
    return deduped
}

// Listing needs metadata and a recent preview, not multi-gigabyte tool output.
// Read complete lines at each end; importing still reads the selected transcript in full.
const SUMMARY_WINDOW_BYTES = 64 * 1024

function readSummaryLines(filePath: string): string[] {
    const fd = openSync(filePath, 'r')
    try {
        const size = fstatSync(fd).size
        const head = Buffer.alloc(Math.min(size, SUMMARY_WINDOW_BYTES))
        const headText = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8')
        if (size <= SUMMARY_WINDOW_BYTES) return headText.split(/\r?\n/).filter(Boolean)
        const tail = Buffer.alloc(SUMMARY_WINDOW_BYTES)
        const tailText = tail.subarray(0, readSync(fd, tail, 0, tail.length, size - tail.length)).toString('utf8')
        return [
            ...headText.slice(0, headText.lastIndexOf('\n')).split(/\r?\n/),
            ...tailText.slice(tailText.indexOf('\n') + 1).split(/\r?\n/)
        ].filter(Boolean)
    } finally {
        closeSync(fd)
    }
}

function parseCodexLocalSession(
    filePath: string,
    includeMessages: boolean,
    sessionIndexTitles = new Map<string, CodexSessionIndexTitle>()
): LocalCodexSessionWithMessages | LocalCodexSessionSummary | null {
    let lines: string[]
    try {
        lines = includeMessages
            ? readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean)
            : readSummaryLines(filePath)
    } catch { return null }
    const headLines = lines.slice(0, 200)
    let sessionId: string | null = null
    let cwd: string | null = null
    let originator: string | null = null
    let cliVersion: string | null = null
    let source: string | null = null
    let threadSource: string | null = null
    let forkedFromId: string | null = null
    let firstUserMessage: string | null = null
    const messages: CodexImportedMessageContent[] = []

    if (includeMessages) {
        for (const line of lines) {
            let record: Record<string, unknown> | null = null
            try { record = asRecord(JSON.parse(line)) } catch { continue }
            if (!record) continue
            const message = convertCodexRecordToImportedMessage(record)
            if (message) messages.push(message)
        }
    }

    for (const line of headLines) {
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue
            if (record.type === 'session_meta') {
                const payload = asRecord(record.payload)
                if (isCodexSubagentSource(payload?.source)) return null
                if (!sessionId && typeof payload?.id === 'string') sessionId = payload.id
                if (!cwd && typeof payload?.cwd === 'string') cwd = payload.cwd
                if (!originator && typeof payload?.originator === 'string') originator = payload.originator
                if (!cliVersion && typeof payload?.cli_version === 'string') cliVersion = payload.cli_version
                if (!source && typeof payload?.source === 'string') source = payload.source
                if (!threadSource && typeof payload?.thread_source === 'string') threadSource = payload.thread_source
                if (!forkedFromId && typeof payload?.forked_from_id === 'string') forkedFromId = payload.forked_from_id
            }
            if (!firstUserMessage && record.type === 'response_item') {
                const payload = asRecord(record.payload)
                if (payload?.type === 'message' && payload.role === 'user') {
                    const text = extractCodexText(payload.content)
                    if (text && !shouldIgnoreSyntheticUserMessage(text)) firstUserMessage = text
                }
            }
        } catch { continue }
    }

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null
    const sessionIndexTitle = sessionIndexTitles.get(sessionId)?.threadName ?? null
    const changedTitle = getLatestCodexChangedTitle(lines)
    const lastUserMessage = getLatestCodexUserMessage(lines)
    let modifiedAt = Date.now()
    try { modifiedAt = statSync(filePath).mtimeMs } catch {}
    const summary = {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, sessionIndexTitle, changedTitle, firstUserMessage),
        lastUserMessage,
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion,
        source,
        threadSource,
        forkedFromId
    }
    return includeMessages ? { ...summary, messages: deduplicateAdjacentImportedMessages(messages) } : summary
}

function listLocalCodexSessions(includeMessages: false, limit?: number): LocalCodexSessionSummary[]
function listLocalCodexSessions(includeMessages: true, limit?: number): LocalCodexSessionWithMessages[]
function listLocalCodexSessions(includeMessages: boolean, limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): Array<LocalCodexSessionSummary | LocalCodexSessionWithMessages> {
    const files: string[] = []
    for (const root of getCodexSessionRoots()) collectJsonlFiles(root, files)
    const sessionIndexTitles = readCodexSessionIndexTitles()
    const deduped = new Map<string, LocalCodexSessionSummary | LocalCodexSessionWithMessages>()
    for (const file of files) {
        const session = parseCodexLocalSession(file, includeMessages, sessionIndexTitles)
        if (!session) continue
        const previous = deduped.get(session.id)
        if (!previous || previous.modifiedAt < session.modifiedAt) deduped.set(session.id, session)
    }
    return Array.from(deduped.values()).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit)
}

type IndexedCodexThread = {
    id: string
    rollout_path: string
    updated_at: number
    cwd: string
    title: string
    source: string
    cli_version: string
    first_user_message: string
    thread_source?: string | null
    preview?: string
    name?: string | null
    originator?: string | null
}

function listIndexedCodexSessions(limit: number): LocalCodexSessionSummary[] | null {
    const home = getCodexHome()
    if (!existsSync(home)) return null
    const databases = readdirSync(home).filter((file) => /^state_\d+\.sqlite$/.test(file))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
    if (databases.length === 0) return null
    // The CLI runs in Bun. Keep SQLite loading lazy so transcript-only environments
    // and the Node unit-test runner do not need a SQLite module.
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(join(home, databases[0]), { readonly: true })
    try {
        const rows = db.query('SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at DESC').all() as IndexedCodexThread[]
        const titles = readCodexSessionIndexTitles()
        return rows.filter((row) => {
            let source: unknown = row.source
            try { source = JSON.parse(row.source) } catch { /* Plain CLI source. */ }
            return !isCodexSubagentSource(source) && existsSync(row.rollout_path)
        }).slice(0, limit).map((row) => ({
            id: row.id,
            title: truncateText(row.name || titles.get(row.id)?.threadName || row.title || row.first_user_message || basename(row.cwd) || row.id.slice(0, 8), 80),
            lastUserMessage: truncateText(row.preview || row.first_user_message || '', 140) || null,
            cwd: row.cwd,
            file: row.rollout_path,
            modifiedAt: row.updated_at * 1000,
            originator: row.originator ?? null,
            cliVersion: row.cli_version,
            source: row.source,
            threadSource: row.thread_source ?? null
        }))
    } finally {
        db.close()
    }
}

export type CodexSessionSearch = { search?: string; cwd?: string | null; cursor?: number; limit?: number }

/** Search the full index before paging; never restrict a search to the newest sessions. */
export function searchLocalCodexSessions(options: CodexSessionSearch = {}): { sessions: LocalCodexSessionSummary[]; nextCursor: number | null } {
    const cursor = options.cursor ?? 0
    const limit = options.limit ?? 50
    const search = options.search?.trim().toLowerCase() ?? ''
    const cwd = options.cwd?.trim() || null
    const home = getCodexHome()
    const databases = existsSync(home) ? readdirSync(home).filter(file => /^state_\d+\.sqlite$/.test(file))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0])) : []
    if (!databases.length) {
        const paths: string[] = []
        for (const root of getCodexSessionRoots()) collectJsonlFiles(root, paths)
        const files = paths.map(file => ({ file, modifiedAt: statSync(file).mtimeMs }))
            .sort((a, b) => b.modifiedAt - a.modifiedAt || b.file.localeCompare(a.file))
        const titles = readCodexSessionIndexTitles()
        const sessions = new Map<string, LocalCodexSessionSummary>()
        let offset = cursor
        while (offset < files.length && sessions.size < limit) {
            const session = parseCodexLocalSession(files[offset++].file, false, titles)
            if (!session || (cwd && session.cwd !== cwd)) continue
            if (search && ![session.title, session.lastUserMessage, session.cwd, session.originator, session.cliVersion, session.id]
                .some(value => value?.toLowerCase().includes(search))) continue
            if (!sessions.has(session.id)) sessions.set(session.id, session)
        }
        return { sessions: [...sessions.values()], nextCursor: offset < files.length ? offset : null }
    }
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(join(home, databases[0]), { readonly: true })
    try {
        const columns = new Set((db.query('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map(column => column.name))
        const searchable = ['name', 'title', 'preview', 'first_user_message', 'cwd', 'originator', 'cli_version', 'id'].filter(column => columns.has(column))
        const titles = readCodexSessionIndexTitles()
        const conditions = ['archived = 0']
        const bindings: Array<string | number> = []
        if (cwd) { conditions.push('cwd = ?'); bindings.push(cwd) }
        if (search) {
            const matchingNames = [...titles].filter(([, title]) => title.threadName.toLowerCase().includes(search)).map(([id]) => id)
            const predicates = searchable.map(column => `instr(lower(coalesce(${column}, '')), ?) > 0`)
            bindings.push(...searchable.map(() => search))
            if (matchingNames.length) {
                predicates.push(`id IN (${matchingNames.map(() => '?').join(', ')})`)
                bindings.push(...matchingNames)
            }
            conditions.push(`(${predicates.join(' OR ')})`)
        }
        const query = db.query(`SELECT * FROM threads WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
        const sessions: LocalCodexSessionSummary[] = []
        let offset = cursor
        let hasMore = false
        do {
            const rows = query.all(...bindings, limit + 1, offset) as IndexedCodexThread[]
            let consumed = 0
            for (const row of rows.slice(0, limit)) {
                consumed++
                let source: unknown = row.source
                try { source = JSON.parse(row.source) } catch { /* Plain CLI source. */ }
                if (isCodexSubagentSource(source) || !existsSync(row.rollout_path)) continue
                sessions.push({
                    id: row.id,
                    title: truncateText(row.name || titles.get(row.id)?.threadName || row.title || row.first_user_message || basename(row.cwd) || row.id.slice(0, 8), 80),
                    lastUserMessage: truncateText(row.preview || row.first_user_message || '', 140) || null,
                    cwd: row.cwd, file: row.rollout_path, modifiedAt: row.updated_at * 1000,
                    originator: row.originator ?? null, cliVersion: row.cli_version, source: row.source, threadSource: row.thread_source ?? null
                })
                if (sessions.length === limit) break
            }
            offset += consumed
            hasMore = rows.length > consumed
        } while (hasMore && sessions.length < limit)
        return { sessions, nextCursor: hasMore ? offset : null }
    } finally { db.close() }
}

export function listLocalCodexSessionSummaries(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): LocalCodexSessionSummary[] {
    return listIndexedCodexSessions(limit) ?? listLocalCodexSessions(false, limit)
}

export function listLocalCodexSessionsWithMessages(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): LocalCodexSessionWithMessages[] {
    return listLocalCodexSessions(true, limit)
}

export function listLocalCodexSessionsWithMessagesByIds(ids: Set<string>): LocalCodexSessionWithMessages[] {
    if (ids.size === 0) return []
    const sessionIndexTitles = readCodexSessionIndexTitles()
    return listLocalCodexSessionSummaries(Number.MAX_SAFE_INTEGER)
        .filter((session) => ids.has(session.id))
        .map((session) => parseCodexLocalSession(session.file, true, sessionIndexTitles))
        .filter((session): session is LocalCodexSessionWithMessages => Boolean(session))
}


export async function archiveLocalCodexSession(sessionId: string, options: ArchiveLocalCodexSessionOptions = {}): Promise<{ success: true; archivedPath: string } | { success: false; error: string }> {
    const normalizedId = sessionId.trim()
    if (!normalizedId) return { success: false, error: 'sessionId is required' }

    const sessionsRoot = getCodexSessionRoots()[0]
    const archivedRoot = join(getCodexHome(), 'archived_sessions')
    const sessions = listLocalCodexSessionSummaries(DEFAULT_CODEX_SESSION_SCAN_LIMIT * 5)
    const target = sessions.find((session) => session.id === normalizedId)
    if (!target) return { success: false, error: 'Codex session not found' }
    if (options.canArchive && !(await options.canArchive(target))) {
        return { success: false, error: 'Codex session is outside workspace roots' }
    }

    const relativePath = relative(sessionsRoot, target.file)
    if (!relativePath || relativePath.startsWith('..')) {
        return { success: false, error: 'Codex session file is outside local sessions root' }
    }

    const archivedPath = join(archivedRoot, relativePath)
    try {
        mkdirSync(dirname(archivedPath), { recursive: true })
        if (existsSync(archivedPath)) {
            return { success: false, error: 'Archived Codex session already exists' }
        }
        renameSync(target.file, archivedPath)
        return { success: true, archivedPath }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to archive Codex session' }
    }
}
