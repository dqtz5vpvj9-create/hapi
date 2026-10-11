export function extendRecentFixture(code) {
    const replace = (needle, value) => {
        if (code.split(needle).length !== 2) throw new Error('Recent fixture contract changed: ' + needle.slice(0, 80))
        code = code.replace(needle, value)
    }
    replace('const sessions: Session[] = titles.map', `const recentCount = Math.max(4, Math.min(5000, Number(params.get('sessionCount')) || 4))
if (params.has('sessionCount')) {
    titles.length = 0
    for (let index = 1; index <= recentCount; index++) titles.push('Recent benchmark ' + String(index).padStart(4, '0'))
}
const recentTime = (index: number) => Date.UTC(2026, 9, 10, 12) - Math.floor(index / 5) * 86400000 - index
const sessions: Session[] = titles.map`)
    replace('updatedAt: createdAt + 320, hasConversationContent', "updatedAt: params.has('sessionCount') ? recentTime(index) : createdAt + 320, hasConversationContent")
    const original = 'const history = new Map(sessions.map(s => [s.id, Array.from({ length: 320 }, (_, i) => message(s.id, i + 1))]))'
    replace(original, `// Logical corpus remains320 rows/session. Materialization is only a fake-Hub cost,
// so do it on actual body requests rather than allocating320,000 unread rows.
const history = params.has('sessionCount') ? new Map<string, DecryptedMessage[]>() : new Map(sessions.map(s => [s.id, Array.from({ length: 320 }, (_, i) => message(s.id, i + 1))]))
if (params.has('sessionCount')) {
    const get = history.get.bind(history)
    history.get = (id: string) => {
        let rows = get(id)
        if (!rows) { rows = Array.from({ length: 320 }, (_, index) => message(id, index + 1)); history.set(id, rows) }
        return rows
    }
}`)
    replace('    fileWrites: []', `    recentBenchmark: { count: recentCount, logicalRowsPerSession: 320 },
    updateRecent(id: string, updatedAt: number) {
        const session = sessions.find(session => session.id === id)!
        session.updatedAt = updatedAt; session.seq++; session.metadataVersion++
        for (const stream of streams) stream.emit({ type: 'session-updated', sessionId: id, data: session })
    },
    insertRecent(id: string, updatedAt: number) {
        if (sessions.some(session => session.id === id)) throw new Error('Duplicate benchmark ID')
        const index = Number(id.split('-').at(-1))
        const session = { ...sessions[0], id, updatedAt, metadata: { ...sessions[0].metadata!, name: 'Recent benchmark ' + String(index).padStart(4, '0'), codexSessionId: 'native-' + index } }
        sessions.push(session)
        for (const stream of streams) stream.emit({ type: 'session-updated', sessionId: id, data: session })
    },
    fileWrites: []`)
    return code
}
