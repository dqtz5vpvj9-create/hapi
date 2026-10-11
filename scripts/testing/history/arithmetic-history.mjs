/** Renderer-local synthetic Hub. No message corpus is allocated or retained.
 * Only response-size work is performed; this is not a Hub/daemon benchmark. */
export function createArithmeticHistory({ count, createdAt, message, sessionIds, clock = () => performance.now(), logLimit = 256 }) {
    if (![320, 10000, 100000].includes(count)) throw new Error('Unsupported logical history length')
    if (!Number.isInteger(logLimit) || logLimit < 1 || logLimit > 1024) throw new Error('Invalid log bound')
    const ids = new Set(sessionIds)
    const epochs = new Map()
    const totals = { requests: 0, generatedBodies: 0, generatedLabels: 0, responseBytes: 0, maxBodiesPerRequest: 0, maxLabelsPerRequest: 0, droppedRecords: 0 }
    const records = []
    const position = seq => ({ at: createdAt + seq, seq })
    const integer = (q, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
        if (!q.has(key)) return fallback
        const text = q.get(key), n = Number(text)
        if (!text || !Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid ' + key)
        return n
    }
    const cursor = (q, name) => {
        const at = integer(q, name + 'At', undefined), seq = integer(q, name + 'Seq', undefined, 1)
        if ((at === undefined) !== (seq === undefined)) throw new Error('Incomplete ' + name + ' cursor')
        return at === undefined ? null : { at, seq }
    }
    // Lexicographic comparison with the synthetic monotonic integer positions.
    const less = p => { const n = p.at - createdAt; return n - (n >= p.seq ? 1 : 0) }
    const atMost = p => { const n = p.at - createdAt; return n - (n > p.seq ? 1 : 0) }
    const bodies = (id, first, last) => {
        const rows = []
        for (let seq = first; seq <= last; seq++) rows.push(message(id, seq))
        return rows
    }
    function read(id, suffix, query, requestStartedAt = clock(), delayMs = 0) {
        const q = query instanceof URLSearchParams ? query : new URLSearchParams(query)
        const startedAt = clock()
        let status = 200, data, bodyCount = 0, labelCount = 0
        const epoch = epochs.get(id) ?? 1
        try {
            if (!ids.has(id)) { status = 404; throw new Error('Session not found') }
            const requestedEpoch = integer(q, 'epoch', undefined)
            const reset = requestedEpoch !== undefined && requestedEpoch !== epoch
            if (suffix === '/messages') {
                const limit = integer(q, 'limit', 50, 1, 200)
                let before = cursor(q, 'before'), after = cursor(q, 'after')
                const until = cursor(q, 'until')
                if (before && after || until && !after || requestedEpoch !== undefined && !before && !after) throw new Error('Invalid cursor combination')
                if (q.has('bounded') && !['true', 'false'].includes(q.get('bounded'))) throw new Error('Invalid bounded')
                if (reset) { before = null; after = null }
                const lo = Math.max(1, after ? atMost(after) + 1 : 1)
                const hi = Math.min(count, before ? less(before) : count, until ? atMost(until) : count)
                const first = after ? lo : Math.max(lo, hi - limit + 1)
                const last = after ? Math.min(hi, lo + limit - 1) : hi
                const rows = bodies(id, first, last)
                bodyCount = rows.length
                const a = rows.length ? position(first) : null, b = rows.length ? position(last) : null
                data = { messages: rows, page: { direction: after ? 'after' : before ? 'before' : 'latest', limit, epoch, reset,
                    nextBeforeAt: a?.at ?? null, nextBeforeSeq: a?.seq ?? null,
                    nextAfterAt: b?.at ?? null, nextAfterSeq: b?.seq ?? null,
                    snapshotHeadAt: createdAt + count, snapshotHeadSeq: count,
                    hasMore: Math.max(0, hi - lo + 1) > rows.length } }
            } else if (suffix === '/messages/outline') {
                const limit = integer(q, 'limit', 40, 1, 100)
                let before = cursor(q, 'before')
                if (before && requestedEpoch === undefined) throw new Error('Outline cursor requires epoch')
                if (reset) before = null
                let last = Math.min(count, before ? less(before) : count)
                if (last % 2 === 0) last--
                const first = Math.max(1, last - (limit - 1) * 2)
                const entries = []
                for (let seq = first; seq <= last; seq += 2) entries.push({ messageId: id + '-m-' + seq,
                    label: id + ' · 问题 ' + seq + '：检查这一步的实际表现。', ...position(seq), createdAt: createdAt + seq })
                labelCount = entries.length
                data = { entries, page: { epoch, reset, hasMore: first > 1 && entries.length > 0,
                    beforeCursor: entries.length ? position(first) : null, scannedThrough: count, headSeq: count,
                    complete: true, unreadable: false, indexing: false } }
            } else if (/^\/messages\/[^/]+\/context$/.test(suffix)) {
                const radius = integer(q, 'radius', 50, 1, 99)
                const messageId = decodeURIComponent(suffix.split('/')[2])
                const prefix = id + '-m-', rawSeq = messageId.startsWith(prefix) ? messageId.slice(prefix.length) : ''
                const seq = Number(rawSeq)
                if (!/^[1-9]\d*$/.test(rawSeq) || !Number.isSafeInteger(seq) || seq > count) { status = 404; throw new Error('Message not found') }
                const first = Math.max(1, seq - radius), last = Math.min(count, seq + radius)
                const rows = bodies(id, first, last); bodyCount = rows.length
                data = { anchor: { messageId, position: position(seq) }, messages: rows,
                    page: { epoch, reset, beforeCursor: position(first), afterCursor: position(last),
                        hasMoreBefore: first > 1, hasMoreAfter: last < count, snapshotHead: position(count) } }
            } else { status = 404; throw new Error('Unsupported history route') }
        } catch (error) { if (status === 200) status = 400; data = { error: error.message } }
        const body = JSON.stringify(data), bytes = new TextEncoder().encode(body).byteLength
        const finishedAt = clock()
        totals.requests++; totals.generatedBodies += bodyCount; totals.generatedLabels += labelCount; totals.responseBytes += bytes
        totals.maxBodiesPerRequest = Math.max(totals.maxBodiesPerRequest, bodyCount)
        totals.maxLabelsPerRequest = Math.max(totals.maxLabelsPerRequest, labelCount)
        if (records.length === logLimit) { records.shift(); totals.droppedRecords++ }
        records.push({ index: totals.requests, id, suffix, query: q.toString(), status, requestStartedAt,
            generationStartedAt: startedAt, finishedAt, delayMs, generationAndSerializationMs: finishedAt - startedAt,
            totalFixtureLatencyMs: finishedAt - requestStartedAt, bodies: bodyCount, labels: labelCount, bytes,
            direction: data.page?.direction ?? null, firstSeq: data.messages?.[0]?.seq ?? data.entries?.[0]?.seq ?? null,
            lastSeq: data.messages?.at(-1)?.seq ?? data.entries?.at(-1)?.seq ?? null })
        return { body, bytes, status }
    }
    return { read, stats: () => ({ logicalRowsPerSession: count, sessions: ids.size, retainedBodies: 0, ...totals,
            records: records.map(row => ({ ...row })) }),
        setEpoch(id, epoch) { if (!ids.has(id) || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid epoch'); epochs.set(id, epoch) } }
}
