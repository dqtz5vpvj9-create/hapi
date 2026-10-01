import { afterEach, describe, expect, it } from 'bun:test'
import { createHistoryReaderFixture } from '../hub/src/test-utils/historyReaderFixture'
import { ApiClient, ApiError } from '../web/src/api/client'
import { HistoryPageRepository, HistoryReadInvalidated, type HistoryPageRequest } from '../web/src/lib/history-page-repository'
import { normalizeDecryptedMessage } from '../web/src/chat/normalize'
import { reduceChatBlocks } from '../web/src/chat/reducer'
import type { NormalizedMessage } from '../web/src/chat/types'

function finishIndex(f: Awaited<ReturnType<typeof createHistoryReaderFixture>>) {
    let batch=f.store.messages.backfillMessageDependencies(f.sessionId)
    for(let i=0;!batch.complete&&i<100;i++)batch=f.store.messages.backfillMessageDependencies(f.sessionId)
    if(!batch.complete)throw new Error('Test index incomplete')
    return f.store.messages.getMessageEpoch(f.sessionId)
}

describe('authorized sparse history dependency reads over real HTTP',()=>{
    it('makes requested legacy history readable through deferred batches while leaving an unopened session unscanned',async()=>{
        const f=await createHistoryReaderFixture(513,true);cleanups.push(f.cleanup)
        const other=f.store.sessions.getOrCreateSession('unopened',null,null,'reader')
        f.store.messages.addMessage(other.id,{role:'user',content:{type:'text',text:'Unopened history'}})
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        const epoch=f.store.messages.getMessageEpoch(f.sessionId)
        const first=await api.getMessageDependencies(f.sessionId,[f.rows[512].id],epoch)
        expect(first.indexScanned).toBe(false)
        expect(first.complete).toBe(false)
        let last=first
        const deadline=Date.now()+3000
        while(!last.indexScanned&&Date.now()<deadline){
            await Bun.sleep(25)
            last=await api.getMessageDependencies(f.sessionId,[f.rows[512].id],epoch)
        }
        expect(last.indexScanned).toBe(true)
        expect(last.complete).toBe(true)
        expect(f.store.messages.backfillMessageDependencies(f.sessionId).enumerated).toBe(0)
        expect(f.store.messages.backfillMessageDependencies(other.id).enumerated).toBe(1)
        expect(f.requests.every(request=>request.method==='GET')).toBe(true)
    })
    it('restores the real tool projection across a 1001-row gap with GETs and no agent action',async()=>{
        const f=await createHistoryReaderFixture(1001);cleanups.push(f.cleanup)
        const call=f.store.messages.addImportedMessage(f.sessionId,{role:'agent',content:{type:'codex',data:{type:'tool-call',callId:'remote-call',name:'CodexBash',input:{command:'pwd'}}}},'remote-call',500).message
        const result=f.store.messages.addImportedMessage(f.sessionId,{role:'agent',content:{type:'codex',data:{type:'tool-call-result',callId:'remote-call',output:'done'}}},'remote-result',5000).message
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        const ctx=await api.getMessageDependencies(f.sessionId,[result.id],finishIndex(f))
        expect(ctx.complete).toBe(true)
        expect(ctx.messages.map(row=>row.id)).toEqual([call.id])
        const seed=(await api.getMessageContext(f.sessionId,result.id,{radius:1})).messages.find(row=>row.id===result.id)!
        const normalized=[...ctx.messages,seed].map(normalizeDecryptedMessage).filter((m):m is NormalizedMessage=>m!==null)
        const block=reduceChatBlocks(normalized,null).blocks.find(b=>b.id==='remote-call')!
        expect(block.kind==='tool-call'&&block.tool.name).toBe('CodexBash')
        expect(block.kind==='tool-call'&&block.tool.state).toBe('completed')
        expect(block.kind==='tool-call'&&block.tool.result).toBe('done')
        expect(f.requests.every(request=>request.method==='GET')).toBe(true)
    })

    it('rejects missing JWT, wrong namespace and any seed from another session without returning content',async()=>{
        const f=await createHistoryReaderFixture(2);cleanups.push(f.cleanup)
        const epoch=finishIndex(f)
        const url=`${f.baseUrl}/api/sessions/${f.sessionId}/messages/dependencies?seeds=${f.rows[0].id}&epoch=${epoch}`
        expect((await fetch(url)).status).toBe(401)
        const denied=await fetch(url,{headers:{Authorization:`Bearer ${await f.tokenForNamespace('other')}`}})
        expect(denied.status).toBe(403)
        expect(await denied.json()).not.toHaveProperty('messages')
        const foreign=f.store.sessions.getOrCreateSession('other-history',null,null,'reader')
        const row=f.store.messages.addMessage(foreign.id,{role:'user',content:{type:'text',text:'Private other session'}})
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        await expect(api.getMessageDependencies(f.sessionId,[f.rows[0].id,row.id],epoch)).rejects.toMatchObject({status:404})
    })

    it('returns an empty reset after rewind and rejects a now-missing seed at the current epoch',async()=>{
        const f=await createHistoryReaderFixture(2);cleanups.push(f.cleanup)
        const epoch=finishIndex(f)
        const changed=f.store.messages.truncateMessagesFromLocalId(f.sessionId,'local-1',[])
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        const reset=await api.getMessageDependencies(f.sessionId,[f.rows[1].id],epoch)
        expect(reset.reset).toBe(true)
        expect(reset.complete).toBe(false)
        expect(reset.messages).toEqual([])
        expect(reset.epoch).toBe(changed.epoch)
        await expect(api.getMessageDependencies(f.sessionId,[f.rows[1].id],changed.epoch)).rejects.toMatchObject({status:404})
    })

    it('reports incomplete indexing without scanning or backfilling the history in the read request',async()=>{
        const f=await createHistoryReaderFixture(1);cleanups.push(f.cleanup)
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        const ctx=await api.getMessageDependencies(f.sessionId,[f.rows[0].id],f.store.messages.getMessageEpoch(f.sessionId))
        expect(ctx.complete).toBe(false)
        expect(ctx.indexReady).toBe(false)
        expect(ctx.issues).toContainEqual({messageId:'',reason:'index-incomplete'})
        const scanned=f.store.messages.backfillMessageDependencies(f.sessionId)
        expect(scanned.enumerated).toBe(1)
    })

    it('validates the seed and epoch bounds before attempting a dependency read',async()=>{
        const f=await createHistoryReaderFixture(1);cleanups.push(f.cleanup)
        const api=new ApiClient(f.token,{baseUrl:f.baseUrl})
        for(const ids of [[],['not-a-raw-message-id'],Array.from({length:201},()=>f.rows[0].id)]){
            await expect(api.getMessageDependencies(f.sessionId,ids,0)).rejects.toMatchObject({status:400})
        }
        await expect(api.getMessageDependencies(f.sessionId,[f.rows[0].id],-1)).rejects.toMatchObject({status:400})
    })
})

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

async function readerFixture(count = 1_201, limits?: ConstructorParameters<typeof HistoryPageRepository>[1]) {
    const fixture = await createHistoryReaderFixture(count)
    cleanups.push(fixture.cleanup)
    const api = new ApiClient(fixture.token, { baseUrl: fixture.baseUrl })
    const repository = new HistoryPageRepository(api, limits)
    return { ...fixture, api, repository }
}

const pos = (row: { createdAt: number; invokedAt: number | null; seq: number }) => ({ at: row.invokedAt ?? row.createdAt, seq: row.seq })

describe('history reading via repository → ApiClient → HTTP → authorized routes → SQLite', () => {
    it('reads across five older-page boundaries then rereads either direction from cache', async () => {
        const f = await readerFixture()
        let result = await f.repository.read(f.sessionId, { direction: 'latest' })
        const requests: HistoryPageRequest[] = []
        for (let i = 0; i < 5; i++) {
            const request: HistoryPageRequest = { direction: 'before', epoch: result.page.epoch,
                cursor: { at: result.page.nextBeforeAt!, seq: result.page.nextBeforeSeq! } }
            requests.push(request)
            result = await f.repository.read(f.sessionId, request)
        }
        expect(f.requests).toHaveLength(6)
        const read = f.repository.readCachedRange(f.sessionId, result.page.epoch, pos(f.rows[1]), pos(f.rows[1_200]))
        expect(read?.map(m => m.id)).toEqual(f.rows.slice(1).map(m => m.id))
        expect(f.repository.readCachedRange(f.sessionId, result.page.epoch, pos(f.rows[450]), pos(f.rows[850]))?.map(m => m.id))
            .toEqual(f.rows.slice(450, 851).map(m => m.id))
        for (const request of requests.reverse()) await f.repository.read(f.sessionId, request)
        expect(f.requests).toHaveLength(6)
        expect(f.requests.every(r => r.method === 'GET')).toBe(true)
    })

    it('coalesces a delayed page request and cannot refill an invalidated authorization lifetime', async () => {
        const f = await readerFixture()
        const gate = f.delayNextResponse()
        const first = f.repository.read(f.sessionId, { direction: 'latest' })
        const second = f.repository.read(f.sessionId, { direction: 'latest' })
        await gate.received
        expect(f.requests).toHaveLength(1)
        f.repository.invalidate()
        gate.release()
        const results = await Promise.allSettled([first, second])
        expect(results.every(r => r.status === 'rejected' && r.reason instanceof HistoryReadInvalidated)).toBe(true)
        expect(f.repository.stats().pages).toBe(0)
        await f.repository.read(f.sessionId, { direction: 'latest' })
        expect(f.requests).toHaveLength(2)
    })

    it('discards delayed old-epoch pages and switches a stale cursor response to the latest coverage', async () => {
        const f = await readerFixture()
        const latest = await f.repository.read(f.sessionId, { direction: 'latest' })
        const request: HistoryPageRequest = { direction: 'before', epoch: latest.page.epoch,
            cursor: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! } }
        const gate = f.delayNextResponse()
        const pending = f.repository.read(f.sessionId, request)
        await gate.received
        const rewind = f.store.messages.truncateMessagesFromLocalId(f.sessionId, 'local-1000', [])
        f.repository.observeEpoch(f.sessionId, rewind.epoch)
        gate.release()
        await expect(pending).rejects.toBeInstanceOf(HistoryReadInvalidated)
        const reset = await f.repository.read(f.sessionId, request)
        expect(reset.page.reset).toBe(true)
        expect(f.repository.getCached(f.sessionId, request)).toBeNull()
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })?.page.epoch).toBe(rewind.epoch)
        expect(f.repository.readCachedRange(f.sessionId, rewind.epoch, pos(f.rows[800]), pos(f.rows[999]))?.map(m => m.id))
            .toEqual(f.rows.slice(800, 1_000).map(m => m.id))
    })

    it('reports a real gap instead of stitching two distant cached regions', async () => {
        const f = await readerFixture()
        const tail = await f.repository.read(f.sessionId, { direction: 'latest' })
        await f.repository.read(f.sessionId, { direction: 'before', epoch: tail.page.epoch, cursor: pos(f.rows[201]) })
        expect(f.repository.readCachedRange(f.sessionId, tail.page.epoch, pos(f.rows[1]), pos(f.rows[1_200]))).toBeNull()
        expect(f.repository.readCachedRange(f.sessionId, tail.page.epoch, pos(f.rows[1]), pos(f.rows[200]))?.map(m => m.id))
            .toEqual(f.rows.slice(1, 201).map(m => m.id))
    })

    it('evicts pages under a byte budget, preserves a pinned reading page, then refetches after release', async () => {
        const f = await readerFixture(600, { totalBytes: 100_000, sessionBytes: 100_000, sessions: 8 })
        const tail = await f.repository.read(f.sessionId, { direction: 'latest' })
        const unpin = f.repository.pin(f.sessionId, { direction: 'latest' })
        const older: HistoryPageRequest = { direction: 'before', epoch: tail.page.epoch,
            cursor: { at: tail.page.nextBeforeAt!, seq: tail.page.nextBeforeSeq! } }
        const middle = await f.repository.read(f.sessionId, older)
        const oldest: HistoryPageRequest = { direction: 'before', epoch: middle.page.epoch,
            cursor: { at: middle.page.nextBeforeAt!, seq: middle.page.nextBeforeSeq! } }
        await f.repository.read(f.sessionId, oldest)
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })).not.toBeNull()
        expect(f.repository.stats().totalBytes).toBeLessThanOrEqual(100_000)
        expect(f.repository.readCachedRange(f.sessionId, tail.page.epoch, pos(f.rows[0]), pos(f.rows[599]))).toBeNull()
        const before = f.requests.length
        unpin()
        await f.repository.read(f.sessionId, older)
        expect(f.requests.length).toBeGreaterThan(before)
        expect(f.repository.stats().totalBytes).toBeLessThanOrEqual(100_000)
    })
    it('does not replace a newer latest snapshot with a delayed reset in the same epoch', async () => {
        const f = await readerFixture(650)
        const tail = await f.repository.read(f.sessionId, { direction: 'latest' })
        const rewind = f.store.messages.truncateMessagesFromLocalId(f.sessionId, 'local-600', [])
        f.repository.observeEpoch(f.sessionId, rewind.epoch)
        const gate = f.delayNextResponse()
        const pending = f.repository.read(f.sessionId, { direction: 'before', epoch: tail.page.epoch, cursor: pos(f.rows[300]) })
        await gate.received
        const added = f.store.messages.addImportedMessage(f.sessionId,
            { role: 'user', content: { type: 'text', text: 'New message after rewind' } }, 'new-head', 5000).message
        await f.repository.read(f.sessionId, { direction: 'latest' }, { refresh: true })
        gate.release()
        await expect(pending).rejects.toBeInstanceOf(HistoryReadInvalidated)
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })?.messages.some(m => m.id === added.id)).toBe(true)
    })

    it('keeps an edited queued message when an overlapping older page arrives late', async () => {
        const f = await readerFixture(500)
        const queued = f.store.messages.addMessage(f.sessionId,
            { role: 'user', content: { type: 'text', text: 'before edit' } }, 'queued-edit', null, 1100)
        const tail = await f.repository.read(f.sessionId, { direction: 'latest' })
        const gate = f.delayNextResponse()
        // Cross-direction cache reuse can satisfy this range without HTTP.
        // Force the network read so the test actually exercises a late response.
        const pending = f.repository.read(f.sessionId, { direction: 'before', epoch: tail.page.epoch, cursor: pos(f.rows[400]) }, { refresh: true })
        await gate.received
        f.store.messages.syncNativeQueuedMessage(f.sessionId, 'queued-edit', 'after edit')
        const fresh = await f.repository.read(f.sessionId, { direction: 'latest' }, { refresh: true })
        gate.release()
        await expect(pending).rejects.toBeInstanceOf(HistoryReadInvalidated)
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })?.messages.find(m => m.id === queued.id)?.content)
            .toEqual(fresh.messages.find(m => m.id === queued.id)?.content)
    })

    it('does not revoke the new authorization lifetime for a delayed old forbidden response', async () => {
        const f = await readerFixture(50)
        const gate = f.delayNextResponse()
        const pending = f.repository.read('missing-session', { direction: 'latest' }).catch(error => error.status)
        await gate.received
        f.repository.invalidate()
        const fresh = await f.repository.read(f.sessionId, { direction: 'latest' })
        gate.release()
        expect(await pending).toBe(403)
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })?.messages).toEqual(fresh.messages)
    })

    it('budgets empty-page metadata and bounds latest reads across hidden events', async () => {
        const f = await readerFixture(1, { totalBytes: 1000, sessionBytes: 1000, sessions: 1 })
        const epoch = f.store.messages.getMessageEpoch(f.sessionId)
        for (let i = 0; i < 100; i++) {
            await f.repository.read(f.sessionId, { direction: 'after', epoch,
                cursor: { at: 2000 + i, seq: 20 + i }, until: { at: 2000 + i, seq: 20 + i } })
        }
        expect(f.repository.stats().pages).toBeLessThan(10)
        expect(f.repository.stats().totalBytes).toBeLessThanOrEqual(1000)
        for (let i = 0; i < 2001; i++) f.store.messages.addImportedMessage(f.sessionId,
            { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Goal active · 8016 tokens' } } }, `hidden-${i}`, 3000 + i)
        const result = await f.repository.read(f.sessionId, { direction: 'latest' })
        expect(result.messages).toHaveLength(0)
        expect(result.page.hasMore).toBe(true)
        expect(f.requests.at(-1)?.query).toContain('bounded=true')
    })

    it('releases resident history when the current identity receives an actual unauthorized response', async () => {
        const f = await readerFixture(50)
        let token = f.token
        const api = new ApiClient(token, { baseUrl: f.baseUrl, getToken: () => token })
        const repository = new HistoryPageRepository(api)
        await repository.read(f.sessionId, { direction: 'latest' })
        expect(repository.stats().messages).toBe(50)
        token = 'expired-invalid-token'
        try {
            await repository.read(f.sessionId, { direction: 'latest' }, { refresh: true })
            throw new Error('An unauthorized read must fail')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).status).toBe(401)
        }
        expect(repository.stats().pages).toBe(0)
        expect(repository.stats().messages).toBe(0)
    })

    it('rejects an older reset even if the accepted new snapshot exceeded the cache budget', async () => {
        const f = await readerFixture(650, { totalBytes: 60_000, sessionBytes: 60_000, sessions: 2 })
        const tail = await f.repository.read(f.sessionId, { direction: 'latest' })
        const rewind = f.store.messages.truncateMessagesFromLocalId(f.sessionId, 'local-600', [])
        f.repository.observeEpoch(f.sessionId, rewind.epoch)
        const gate = f.delayNextResponse()
        const pending = f.repository.read(f.sessionId, { direction: 'before', epoch: tail.page.epoch, cursor: pos(f.rows[300]) })
        await gate.received
        const added = f.store.messages.addImportedMessage(f.sessionId,
            { role: 'user', content: { type: 'text', text: 'x'.repeat(60_000) } }, 'large-head', 5000).message
        const fresh = await f.repository.read(f.sessionId, { direction: 'latest' }, { refresh: true })
        expect(fresh.messages.some(m => m.id === added.id)).toBe(true)
        expect(f.repository.stats().pages).toBe(0)
        gate.release()
        await expect(pending).rejects.toBeInstanceOf(HistoryReadInvalidated)
        expect(f.repository.getCached(f.sessionId, { direction: 'latest' })).toBeNull()
    })

    it('preserves the new identity cache after an old identity delayed unauthorized response', async () => {
        const f = await readerFixture(50)
        let token = 'invalid-old-token'
        const repository = new HistoryPageRepository(new ApiClient(token, { baseUrl: f.baseUrl, getToken: () => token }))
        const gate = f.delayNextResponse()
        const pending = repository.read(f.sessionId, { direction: 'latest' }).catch(error => error)
        await gate.received
        repository.invalidate()
        token = f.token
        const fresh = await repository.read(f.sessionId, { direction: 'latest' })
        gate.release()
        expect((await pending as ApiError).status).toBe(401)
        expect(repository.getCached(f.sessionId, { direction: 'latest' })?.messages).toEqual(fresh.messages)
    })

})
