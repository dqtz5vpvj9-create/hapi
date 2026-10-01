import { afterEach, describe, expect, it } from 'bun:test'
import { Store, type StoredMessage } from '../hub/src/store'
import { normalizeDecryptedMessage } from '../web/src/chat/normalize'
import { reduceChatBlocks } from '../web/src/chat/reducer'
import { isObject } from '../shared/src/utils'
import type { DecryptedMessage } from '../web/src/types/api'
import type { NormalizedMessage } from '../web/src/chat/types'
import claude from '../shared/fixtures/chat/claude-tool-use-result-pair.json'
import codex from '../shared/fixtures/chat/codex-tool-call-result-pair.json'
import task from '../shared/fixtures/chat/sidechain-task-nested-children.json'

const stores: Store[] = []
afterEach(()=>{for(const store of stores.splice(0))store.close()})
const wire = (row: StoredMessage): DecryptedMessage => ({ id: row.id, localId: row.localId, createdAt: row.createdAt,
    seq: row.seq, content: row.content, invokedAt: row.invokedAt, scheduledAt: row.scheduledAt })
const project = (rows: StoredMessage[]) => reduceChatBlocks([...rows].sort((a,b)=>(a.invokedAt??a.createdAt)-(b.invokedAt??b.createdAt)||a.seq-b.seq)
    .map(row=>normalizeDecryptedMessage(wire(row)))
    .filter((row): row is NormalizedMessage => row !== null),null)
function fixtureReader(messages: Array<{content: unknown;createdAt:number}>) {
    const store=new Store(':memory:');stores.push(store)
    const session=store.sessions.getOrCreateSession('fixture-history',null,null,'reader')
    const saved: StoredMessage[]=[]
    messages.forEach((message,i)=>{
        const row=store.messages.addImportedMessage(session.id,message.content,`fixture-${i}`,message.createdAt).message
        saved.push(row)
        if(i===1)for(let gap=0;gap<1001;gap++)store.messages.addImportedMessage(session.id,
            {role:'user',content:{type:'text',text:`unrelated page gap ${gap}`}},`gap-${gap}`,message.createdAt+1)
    })
    let batch=store.messages.backfillMessageDependencies(session.id)
    for(let i=0;!batch.complete&&i<100;i++)batch=store.messages.backfillMessageDependencies(session.id)
    if(!batch.complete)throw new Error('Fixture index backfill did not complete')
    return {store,session,saved,epoch:store.messages.getMessageEpoch(session.id)}
}

describe('far-history relationship recovery through SQLite index and actual Web projection',()=>{
    it('restores a lone agent trace to its complete card, tool name and terminal status',()=>{
        const run=(data:unknown)=>({role:'agent',content:{type:'codex',data}})
        const f=fixtureReader([
            {createdAt:1000,content:run({type:'agent-run-start',agentId:'reader-agent',cardId:'reader-card',status:'running'})},
            {createdAt:2000,content:run({type:'agent-run-trace',agentId:'reader-agent',cardId:'reader-card',message:{type:'tool-call',name:'CodexBash',callId:'reader-command',input:{command:'pwd'}}})},
            {createdAt:3000,content:run({type:'agent-run-trace',agentId:'reader-agent',cardId:'reader-card',message:{type:'tool-call-result',callId:'reader-command',output:'done'}})},
            {createdAt:4000,content:run({type:'agent-run-update',agentId:'reader-agent',cardId:'reader-card',status:'completed',result:'agent done'})},
        ])
        const seed=f.saved[2]
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
        const full=project(f.saved).blocks.find(block=>block.id==='reader-card')!
        const partial=project([seed,...context.messages]).blocks.find(block=>block.id==='reader-card')!
        expect(full.kind==='tool-call'&&full.tool.state).toBe('completed')
        expect(partial).toEqual(full)
        expect(context.complete).toBe(true)
        expect(context.indexReady).toBe(true)
        expect(context.messages.length).toBe(3)
    })

    it('joins fallback and explicit agent cards across event envelopes without mixing another agent with the same inner call ID',()=>{
        const run=(data:unknown,type='codex')=>({role:'agent',content:{type,data}})
        const messages=[
            {createdAt:1000,content:run({type:'agent-run-trace',agent_id:'agent-a',message:{type:'tool-call',callId:'same-command',name:'CodexBash',input:{command:'pwd'}}},'event')},
            {createdAt:2000,content:run({type:'agent-run-start',agentId:'agent-a',card_id:'explicit-a',status:'running'})},
            {createdAt:3000,content:run({type:'agent-run-trace',agentId:'agent-a',cardId:'explicit-a',message:{type:'tool-call-result',callId:'same-command',output:'A only'}})},
            {createdAt:4000,content:run({type:'agent-run-update',agentId:'agent-a',status:'completed',result:'A done'},'event')},
            {createdAt:5000,content:run({type:'agent-run-trace',agentId:'agent-b',cardId:'explicit-b',message:{type:'tool-call',callId:'same-command',name:'Other tool',input:{command:'B only'}}})},
        ]
        const f=fixtureReader(messages)
        const seed=f.saved[2]
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
        expect(context.complete).toBe(true)
        expect(context.messages.some(row=>row.id===f.saved[4].id)).toBe(false)
        const actual=project([seed,...context.messages]).blocks.find(block=>block.id==='explicit-a')
        expect(actual).toEqual(project(f.saved).blocks.find(block=>block.id==='explicit-a'))
        expect(actual?.kind==='tool-call'&&actual.children[0]?.kind==='tool-call'&&actual.children[0].tool.name).toBe('CodexBash')
    })

    it('restores orphan start replacement so an older page does not revive a superseded card',()=>{
        const run=(cardId:string)=>({role:'agent',content:{type:'codex',data:{type:'agent-run-start',cardId,input:{message:'Inspect   the repo'},status:'running'}}})
        const f=fixtureReader([{createdAt:1000,content:run('orphan-old')},{createdAt:2000,content:run('orphan-current')}])
        const seed=f.saved[0]
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
        expect(context.complete).toBe(true)
        const actual=project([seed,...context.messages])
        expect(actual).toEqual(project(f.saved))
        expect(actual.blocks.some(block=>block.id==='orphan-old')).toBe(false)
    })

    it('restores a shared card when one event names another agent\'s derived fallback card',()=>{
        const run=(data:unknown)=>({role:'agent',content:{type:'codex',data}})
        const f=fixtureReader([
            {createdAt:1000,content:run({type:'agent-run-trace',agentId:'fallback-agent',message:{type:'tool-call',callId:'one',name:'CodexBash',input:{command:'pwd'}}})},
            {createdAt:2000,content:run({type:'agent-run-trace',agentId:'other-agent',cardId:'codex-agent:fallback-agent',message:{type:'message',message:'Shared card content'}})},
            {createdAt:3000,content:run({type:'agent-run-update',agentId:'other-agent',cardId:'codex-agent:fallback-agent',status:'completed'})},
        ])
        const seed=f.saved[1]
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
        expect(context.complete).toBe(true)
        expect(project([seed,...context.messages]).blocks.find(block=>block.id==='codex-agent:fallback-agent'))
            .toEqual(project(f.saved).blocks.find(block=>block.id==='codex-agent:fallback-agent'))
    })

    it('joins an anonymous start to an update that explicitly references its raw message ID in either direction',()=>{
        const f=fixtureReader([{createdAt:1000,content:{role:'agent',content:{type:'codex',data:{type:'agent-run-start',status:'running',input:{message:'Inspect files'}}}}}])
        const start=f.saved[0]
        const update=f.store.messages.addImportedMessage(f.session.id,{role:'agent',content:{type:'event',data:{type:'agent-run-update',cardId:start.id,status:'completed',result:'Done'}}},'anonymous-update',2000).message
        f.store.messages.backfillMessageDependencies(f.session.id)
        const full=project([start,update]).blocks.find(block=>block.id===start.id)
        expect(full?.kind==='tool-call'&&full.tool.state).toBe('completed')
        for(const seed of [start,update]){
            const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
            expect(context.complete).toBe(true)
            expect(project([seed,...context.messages]).blocks.find(block=>block.id===start.id)).toEqual(full)
        }
    })
    for(const [name,fixture] of [['Claude command',claude],['Codex command',codex],['subagent conversation',task]] as const) {
        it(`recovers ${name} across a 1001-message gap with the same tool content as the full conversation`,()=>{
            const f=fixtureReader(fixture.input.messages)
            const baseline=project(f.store.messages.getAllMessages(f.session.id))
            const target=baseline.blocks.find(block=>block.kind==='tool-call')!
            const seed=name==='subagent conversation'?f.saved[1]:f.saved.find(row=>{
                const normalized=normalizeDecryptedMessage(wire(row))
                return normalized?.role==='agent'&&normalized.content.some(part=>part.type==='tool-result'&&part.tool_use_id===target.id)
            })!
            if(!seed)throw new Error('Fixture target tool result missing')
            const context=f.store.messages.getMessageDependencyContext(f.session.id,[seed.id],f.epoch)
            expect(context.complete).toBe(true)
            expect(context.messages.length).toBeLessThan(10)
            expect(context.messages.some(row=>row.localId?.startsWith('gap-'))).toBe(false)
            const recovered=project([seed,...context.messages].sort((a,b)=>(a.invokedAt??a.createdAt)-(b.invokedAt??b.createdAt)||a.seq-b.seq))
                .blocks.find(block=>block.id===target.id)
            expect(recovered).toEqual(target)
        })
    }

    it('restores both parallel subagent trees in one call message without mixing their contents',()=>{
        const messages: Array<{content:unknown;createdAt:number}>=structuredClone(task.input.messages)
        const parent=messages[1].content
        if(!isObject(parent)||!isObject(parent.content)||!isObject(parent.content.data)||!isObject(parent.content.data.message)
            ||!Array.isArray(parent.content.data.message.content))throw new Error('Task fixture parent structure changed')
        const parts=parent.content.data.message.content
        const first=parts.find(part=>isObject(part)&&part.type==='tool_use')
        if(!isObject(first))throw new Error('Task fixture lost its call')
        parts.push({...first,id:'task-second',input:{prompt:'Second independent task'}})
        const copies=messages.filter(message=>{
            const content=message.content
            return isObject(content)&&isObject(content.content)&&isObject(content.content.data)&&content.content.data.isSidechain===true
        }).map(message=>{
            const copied=structuredClone(message)
            const data=(copied.content as {content:{data:Record<string,unknown>}}).content.data
            data.parentToolUseId='task-second'
            if(typeof data.uuid==='string')data.uuid=`second-${data.uuid}`
            if(typeof data.parentUuid==='string')data.parentUuid=`second-${data.parentUuid}`
            if(isObject(data.message)&&Array.isArray(data.message.content))for(const part of data.message.content){
                if(!isObject(part))continue
                if(part.type==='tool_use'&&typeof part.id==='string')part.id=`second-${part.id}`
                if(part.type==='tool_result'&&typeof part.tool_use_id==='string')part.tool_use_id=`second-${part.tool_use_id}`
            }
            copied.createdAt+=500
            return copied
        })
        const f=fixtureReader([...messages,...copies])
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[f.saved[1].id],f.epoch)
        expect(context.complete).toBe(true)
        const recovered=project([f.saved[1],...context.messages].sort((a,b)=>(a.invokedAt??a.createdAt)-(b.invokedAt??b.createdAt)||a.seq-b.seq))
        const baseline=project(f.store.messages.getAllMessages(f.session.id))
        for(const id of [String(first.id),'task-second']){
            const actual=recovered.blocks.find(block=>block.kind==='tool-call'&&block.id===id)
            expect(actual).toEqual(baseline.blocks.find(block=>block.kind==='tool-call'&&block.id===id))
            expect(actual?.kind==='tool-call'?actual.children.length:0).toBe(3)
        }
    })
})
