import type { Database } from 'bun:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import type { MessageDependencyFact, MessageDependencyIssue, MessageDependencyKind } from '@hapi/protocol/messageDependencies'
import { MESSAGE_DEPENDENCY_VERSION } from '@hapi/protocol/messageDependencies'
import { findMessageDependencyCandidates } from './messageDependencies'
import { prepareCached } from './statementCache'
import type { StoredMessage } from './types'

export type DependencyIssue = MessageDependencyIssue
export class HistoryDependencySeedNotFound extends Error {}
export type MessageDependencyContext = {
    epoch: number
    reset: boolean
    indexReady: boolean
    indexScanned: boolean
    seedMessageIds: string[]
    messages: StoredMessage[]
    complete: boolean
    issues: DependencyIssue[]
    pendingMessageIds: string[]
}

type Row = {
    id: string; seq: number; created_at: number; local_id: string | null
    invoked_at: number | null; scheduled_at: number | null; delivery_state: string
    extractor_version: number | null; status: string | null; is_sidechain: number | null
}
type IndexedRow = Row & { facts: MessageDependencyFact[] }
type Candidate = ReturnType<typeof findMessageDependencyCandidates>[number]
const compare = (a: Candidate, b: Candidate) => a.at - b.at || a.seq - b.seq || a.ordinal - b.ordinal
class BudgetReached extends Error {}

/** Sparse context, never continuous page coverage. The caller must already
 * authorize the canonical session. Every seed is checked before any lookup.
 * Scope/coverage checks precede the walker (at most five metadata queries).
 * The walker has its own query budget and soft time limit, checked between
 * bounded operations. Byte accounting covers decoded JSON, not total heap.
 * No writes, backfill, agent lifecycle or model invocation occurs here. */
export function getMessageDependencyContext(
    db: Database, sessionId: string, seedIds: string[], expectedEpoch: number,
    limits = { messages: 200, queries: 512, bytes: 4 * 1024 * 1024, timeMs: 20 },
): MessageDependencyContext {
    if (seedIds.length > 200) throw new RangeError('At most 200 history seeds per read')
    return db.transaction(() => {
        const epoch = (prepareCached(db, 'SELECT epoch FROM message_epochs WHERE session_id=?').get(sessionId) as { epoch: number } | null)?.epoch ?? 0
        const result: MessageDependencyContext = { epoch, reset: expectedEpoch !== epoch, indexReady: false, indexScanned: false,
            seedMessageIds: [...new Set(seedIds)], messages: [], complete: false, issues: [], pendingMessageIds: [] }
        if (result.reset) return result
        const seedSet = new Set(result.seedMessageIds)
        if (seedSet.size) {
            const placeholders = [...seedSet].map(() => '?').join(',')
            const found = prepareCached(db, `SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND id IN (${placeholders})`)
                .get(sessionId, ...seedSet) as { count: number }
            if (found.count !== seedSet.size) throw new HistoryDependencySeedNotFound('History seed not found in session')
        }
        const head = (prepareCached(db, 'SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE session_id=?').get(sessionId) as { seq: number }).seq
        const scan = prepareCached(db, 'SELECT * FROM message_dependency_scan WHERE session_id=?').get(sessionId) as {
            epoch: number; extractor_version: number; last_seq: number
        } | null
        result.indexScanned = head === 0 || Boolean(scan && scan.epoch === epoch && scan.extractor_version === MESSAGE_DEPENDENCY_VERSION && scan.last_seq >= head)
        result.indexReady = result.indexScanned
        // Unrecognized historical formats may contain keys not present in the
        // index. A found relationship therefore cannot prove global absence.
        const unparsed = prepareCached(db, `SELECT 1 FROM message_dependency_state
            WHERE session_id=? AND extractor_version=? AND status IN ('unsupported','decode_error') LIMIT 1`)
            .get(sessionId, MESSAGE_DEPENDENCY_VERSION)
        result.indexReady &&= !unparsed
        if (!result.indexReady) result.issues.push({ messageId: '', reason: 'index-incomplete' })

        const started = performance.now()
        let queries = 0, decodedBytes = 0
        const rows = new Map<string, IndexedRow>()
        const keys = new Map<string, Candidate[]>()
        const queue = [...seedSet]
        const enqueued = new Set(queue)
        const owners = new Map<string, string | null>()
        const ancestry = new Map<string, string[]>()
        const issue = (messageId: string, reason: DependencyIssue['reason'], relation?: MessageDependencyKind) => {
            if (!result.issues.some(item => item.messageId === messageId && item.reason === reason && item.relation === relation)) {
                result.issues.push({ messageId, reason, ...(relation ? { relation } : {}) })
            }
        }
        const charge = () => {
            if (++queries > limits.queries || performance.now() - started >= limits.timeMs) throw new BudgetReached()
        }
        const load = (id: string): IndexedRow => {
            const cached = rows.get(id)
            if (cached) return cached
            charge()
            const row = prepareCached(db, `SELECT m.id,m.seq,m.created_at,m.local_id,m.invoked_at,m.scheduled_at,m.delivery_state,
                s.extractor_version,s.status,s.is_sidechain FROM messages m
                LEFT JOIN message_dependency_state s ON s.message_id=m.id WHERE m.id=? AND m.session_id=?`)
                .get(id, sessionId) as Row | null
            if (!row) throw new Error('History dependency no longer exists in read snapshot')
            if (row.extractor_version !== MESSAGE_DEPENDENCY_VERSION || row.status !== 'indexed') {
                issue(id, 'unsupported')
                const indexed = { ...row, facts: [] }
                rows.set(id, indexed)
                return indexed
            }
            charge()
            const facts = prepareCached(db, 'SELECT kind,key,ordinal FROM message_dependency_keys WHERE message_id=? AND session_id=? LIMIT 257')
                .all(id, sessionId) as MessageDependencyFact[]
            if (facts.length > 256) { issue(id, 'budget'); throw new BudgetReached() }
            const indexed = { ...row, facts }
            rows.set(id, indexed)
            if (row.extractor_version !== MESSAGE_DEPENDENCY_VERSION || row.status !== 'indexed') issue(id, 'unsupported')
            return indexed
        }
        const lookup = (source: string, kind: MessageDependencyKind, key: string): Candidate[] => {
            const cacheKey = JSON.stringify([kind, key])
            const cached = keys.get(cacheKey)
            if (cached) return cached
            charge()
            const matches = findMessageDependencyCandidates(db, sessionId, kind, key)
            if (matches.length === 201) issue(source, 'budget', kind)
            keys.set(cacheKey, matches)
            return matches
        }
        const add = (id: string) => {
            if (enqueued.has(id)) return
            if (enqueued.size - seedSet.size >= limits.messages) { issue(id, 'budget'); throw new BudgetReached() }
            enqueued.add(id)
            queue.push(id)
        }
        const ownedBy = (id: string, chain = new Set<string>()): string | null => {
            if (owners.has(id)) return owners.get(id)!
            if (chain.has(id)) { issue(id, 'missing-parent', 'sdk_parent'); return null }
            chain.add(id)
            const row = load(id)
            if (!row.is_sidechain) return null
            for (const fact of row.facts.filter(f => f.kind === 'parent_tool_use')) {
                const calls = lookup(id, 'subagent_call', fact.key)
                if (calls.length) {
                    if (calls.length > 1) issue(id, 'ambiguous-parent', 'parent_tool_use')
                    ancestry.set(id, calls.map(call => call.id))
                    owners.set(id, fact.key)
                    return fact.key
                }
            }
            // A partial index cannot establish the absence of a preferred
            // parent or the last legacy prompt candidate. Leave fallback
            // ownership unresolved until coverage is authoritative.
            if (!result.indexReady) {
                issue(id, 'index-incomplete')
                owners.set(id, null)
                return null
            }
            for (const fact of row.facts.filter(f => f.kind === 'sidechain_prompt')) {
                const calls = lookup(id, 'task_prompt', fact.key)
                if (calls.length) {
                    if (calls.length > 1) issue(id, 'ambiguous-parent', 'sidechain_prompt')
                    // Preserve the tracer's last-indexed-prompt behavior. Large
                    // or ambiguous candidate sets remain explicitly incomplete.
                    if (calls.length === 201) { owners.set(id, null); return null }
                    const selected = [...calls].sort(compare).at(-1)!
                    const parent = load(selected.id)
                    const call = parent.facts.find(f => f.kind === 'subagent_call' && f.ordinal === selected.ordinal)
                    if (call) { ancestry.set(id, [parent.id]); owners.set(id, call.key); return call.key }
                }
            }
            for (const fact of row.facts.filter(f => f.kind === 'sdk_parent')) {
                const parents = lookup(id, 'sdk_uuid', fact.key).filter(candidate => candidate.isSidechain)
                if (parents.length > 1) issue(id, 'ambiguous-parent', 'sdk_parent')
                if (parents.length === 201) { owners.set(id, null); return null }
                for (const parent of [...parents].sort(compare).reverse()) {
                    const owner = ownedBy(parent.id, new Set(chain))
                    if (owner) { ancestry.set(id, [parent.id, ...(ancestry.get(parent.id) ?? [])]); owners.set(id, owner); return owner }
                }
            }
            owners.set(id, null)
            issue(id, 'missing-parent')
            return null
        }
        let expanded = 0
        try {
            while (expanded < queue.length) {
                const id = queue[expanded]
                const row = load(id)
                if (!seedSet.has(id)) {
                    charge()
                    const raw = prepareCached(db, 'SELECT content FROM messages WHERE id=? AND session_id=?').get(id, sessionId) as { content: string | Uint8Array }
                    try {
                        if (limits.bytes - decodedBytes <= 0) throw new BudgetReached()
                        const json = typeof raw.content === 'string' ? raw.content : zstdDecompressSync(raw.content, { maxOutputLength: Math.min(2 * 1024 * 1024, limits.bytes - decodedBytes) }).toString('utf8')
                        const size = Buffer.byteLength(json)
                        if (size > Math.min(2 * 1024 * 1024, limits.bytes - decodedBytes)) throw new BudgetReached()
                        const content = JSON.parse(json) as unknown
                        decodedBytes += size
                        result.messages.push({ id, sessionId, seq: row.seq, createdAt: row.created_at, localId: row.local_id,
                            invokedAt: row.invoked_at, scheduledAt: row.scheduled_at, content,
                            ...(row.delivery_state !== 'queued' ? { deliveryState: 'indeterminate' as const } : {}) })
                    } catch (error) {
                        const quotaExceeded = error instanceof BudgetReached || (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
                        issue(id, quotaExceeded ? 'budget' : 'unreadable')
                        throw new BudgetReached()
                    }
                }
                if (row.is_sidechain) {
                    ownedBy(id)
                    for (const ancestor of ancestry.get(id) ?? []) add(ancestor)
                }
                for (const fact of row.facts) {
                    if (fact.kind === 'tool_result') {
                        const calls = lookup(id, 'tool_call', fact.key)
                        if (!calls.length) issue(id, result.indexReady ? 'missing-parent' : 'index-incomplete', 'tool_result')
                        if (calls.length > 1) issue(id, 'ambiguous-parent', 'tool_result')
                        for (const call of calls) add(call.id)
                    } else if (fact.kind === 'tool_call') {
                        for (const candidate of lookup(id, 'tool_result', fact.key)) add(candidate.id)
                    } else if (fact.kind === 'subagent_call') {
                        for (const candidate of lookup(id, 'parent_tool_use', fact.key)) {
                            if (candidate.isSidechain && ownedBy(candidate.id) === fact.key) add(candidate.id)
                        }
                        const prompt = row.facts.find(f => f.kind === 'task_prompt' && f.ordinal === fact.ordinal)
                        if (prompt) for (const candidate of lookup(id, 'sidechain_prompt', prompt.key)) {
                            if (candidate.isSidechain && ownedBy(candidate.id) === fact.key) add(candidate.id)
                        }
                    } else if (fact.kind === 'sdk_uuid' && row.is_sidechain) {
                        const owner = ownedBy(id)
                        if (owner) for (const candidate of lookup(id, 'sdk_parent', fact.key)) {
                            if (candidate.isSidechain && ownedBy(candidate.id) === owner) add(candidate.id)
                        }
                    } else if (fact.kind === 'text_stream' || fact.kind === 'reasoning_stream'
                        || fact.kind === 'agent_run_agent' || fact.kind === 'agent_run_card' || fact.kind === 'agent_run_orphan') {
                        for (const candidate of lookup(id, fact.kind, fact.key)) add(candidate.id)
                    }
                }
                expanded++
            }
        } catch (error) {
            if (!(error instanceof BudgetReached)) throw error
            issue(queue[expanded] ?? '', 'budget')
        }
        result.messages.sort((a, b) => (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt) || a.seq - b.seq)
        result.pendingMessageIds = [...new Set([...queue.slice(expanded), ...result.issues.filter(item => item.reason === 'budget' && item.messageId).map(item => item.messageId)])]
        result.complete = result.indexReady && result.issues.length === 0 && result.pendingMessageIds.length === 0
        return result
    })()
}
