import { extendRecentFixture } from '../recent/fixture-transform.mjs'
import { createArithmeticHistory } from './arithmetic-history.mjs'

export function extendLongHistoryFixture(raw) {
    let code = extendRecentFixture(raw)
    const replace = (needle, replacement) => {
        if (code.split(needle).length !== 2) throw new Error('Long history fixture contract changed: ' + needle.slice(0, 100))
        code = code.replace(needle, replacement)
    }
    replace("const params = new URLSearchParams(location.search)", `const params = new URLSearchParams(location.search)
if (!params.has('sessionCount')) params.set('sessionCount', '1000')
if (params.get('sessionCount') !== '1000') throw new Error('Long-history experiment requires1000 summaries')
if (params.has('mixed')) throw new Error('Long-history fixture implements native Codex history only')
if (params.has('rich')) throw new Error('Rich-content long-history experiments require a separate tail-relative corpus')
const logicalHistoryCount = Number(params.get('historyCount') ?? 320)
const historyDelayMs = Number(params.get('historyDelayMs') ?? 30)
if (![320, 10000, 100000].includes(logicalHistoryCount) || !Number.isFinite(historyDelayMs) || historyDelayMs < 0 || historyDelayMs > 2000) throw new Error('Invalid history fixture parameters')`)
    replace("id: `chat-${index + 1}`, namespace: 'fixture', seq: 320", "id: `chat-${index + 1}`, namespace: 'fixture', seq: logicalHistoryCount")
    const start = code.indexOf('// Logical corpus remains320 rows/session.')
    const end = code.indexOf('const streams = new Set<FixtureSource>()', start)
    if (start < 0 || end < 0) throw new Error('Long history lazy corpus boundary changed')
    code = code.slice(0, start) + `const createArithmeticHistory = ${createArithmeticHistory.toString()}
const arithmeticHistory = createArithmeticHistory({ count: logicalHistoryCount, createdAt, message, sessionIds: sessions.map(s => s.id) })
let generalRequestCount = 0
// Mutation helpers from the general fixture are deliberately unsupported here.
// Throw rather than accidentally materializing a complete synthetic history.
const history = { get(_id: string): DecryptedMessage[] { throw new Error('Long-history fixture is read-only') }, set(_id: string, _rows: DecryptedMessage[]) { throw new Error('Long-history fixture is read-only') } }
` + code.slice(end)
    replace('recentBenchmark: { count: recentCount, logicalRowsPerSession: 320 },', `recentBenchmark: { count: recentCount, logicalRowsPerSession: logicalHistoryCount },
    historyBenchmark: { stats: arithmeticHistory.stats, setEpoch: arithmeticHistory.setEpoch, generalRequestCount: () => generalRequestCount },
    activeMessageWindow(sessionId: string) {
        const state = getMessageWindowState(sessionId)
        return { rows: state.messages.length, oldestSeq: state.oldestSeq, newestSeq: state.newestSeq,
            epoch: state.epoch, viewMode: state.viewMode, hasMore: state.hasMore, hasMoreAfter: state.hasMoreAfter,
            isSyncingTail: state.isSyncingTail, isLoadingMore: state.isLoadingMore }
    },`)
    const windowsStart = code.indexOf('    messageWindows() {')
    const windowsEnd = code.indexOf('    captureReading(sessionId: string)', windowsStart)
    if (windowsStart < 0 || windowsEnd < 0) throw new Error('Long history observation boundary changed')
    code = code.slice(0, windowsStart) + `    messageWindows() { throw new Error('Use activeMessageWindow only after entry; never create1000 empty stores for observation') },
` + code.slice(windowsEnd)
    replace("    probe.requests.push(`${method} ${path}${url.search}`)", `    generalRequestCount++
    if (probe.requests.length >= 2048) probe.requests.shift()
    probe.requests.push(\`\${method} \${path}\${url.search}\`)
    const historyRoute = path.match(/^\\/api\\/sessions\\/([^/]+)(\\/messages(?:\\/outline|\\/[^/]+\\/context)?)$/)
    if (method === 'GET' && historyRoute) {
        const requestStartedAt = performance.now()
        if (heldHistory) await heldHistory
        await new Promise(resolve => setTimeout(resolve, historyDelayMs))
        const result = arithmeticHistory.read(historyRoute[1], historyRoute[2], url.searchParams, requestStartedAt, historyDelayMs)
        probe.responseBytes += result.bytes
        return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json' } })
    }`)
    return code
}
