import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from './index'
import { getMessageDependencyContext } from './messageDependencyContext'
import { findMessageDependencyCandidatePage, type MessageDependencyCandidateCursor } from './messageDependencies'
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup() {
    const store = new Store(':memory:'); stores.push(store)
    const db = (store as unknown as { db: Database }).db
    const session = store.sessions.getOrCreateSession(randomUUID(), null, null, 'reader')
    const append = (content: unknown) => store.messages.addMessage(session.id, content)
    const ready = () => { let b = store.messages.backfillMessageDependencies(session.id); for (let i=0; !b.complete && i<200; i++) b=store.messages.backfillMessageDependencies(session.id); if (!b.complete) throw new Error('Test backfill failed'); return store.messages.getMessageEpoch(session.id) }
    return { store, db, session, append, ready }
}
const codex = (data: unknown) => ({ role: 'agent', content: { type: 'codex', data } })
const sdk = (type: string, uuid: string, blocks: unknown, extra = {}) => ({ role: 'agent', content: { type: 'output', data: { type, uuid, message: { content: blocks }, ...extra } } })
const task = (id: string, prompt: string) => ({ type: 'tool_use', id, name: 'Task', input: { prompt } })

describe('bounded sparse history dependency contexts', () => {
    it('finds a result call across 1001 unrelated messages without returning the gap as history', () => {
        const f = setup()
        const call = f.append(codex({ type: 'tool-call', callId: 'far-command', name: 'Bash', input: { command: 'pwd' } }))
        for(let i=0;i<1001;i++) f.append({ role:'user', content:{type:'text',text:`unrelated ${i}`} })
        const result = f.append(codex({ type: 'tool-call-result', callId: 'far-command', output: 'success' }))
        const ctx = f.store.messages.getMessageDependencyContext(f.session.id, [result.id], f.ready())
        expect(ctx.complete).toBe(true)
        expect(ctx.messages.map(row=>row.id)).toEqual([call.id])
        expect(ctx.seedMessageIds).toEqual([result.id])
    })

    it('closes modern subagent membership in both directions and ignores ordinary SDK parent chains', () => {
        const f = setup()
        const parent = f.append(sdk('assistant','task-row',[task('task-a','Explore')]))
        const child = f.append(sdk('assistant','child-uuid',[{type:'text',text:'Answer'}], { isSidechain:true,parentToolUseId:'task-a', parentUuid:'task-row' }))
        const ordinary = f.append(sdk('assistant','ordinary',[{type:'text',text:'Other answer'}], {parentUuid:'child-uuid'}))
        const epoch=f.ready()
        const fromParent=f.store.messages.getMessageDependencyContext(f.session.id,[parent.id],epoch)
        expect(fromParent.complete).toBe(true)
        expect(fromParent.messages.map(m=>m.id)).toEqual([child.id])
        const fromChild=f.store.messages.getMessageDependencyContext(f.session.id,[child.id],epoch)
        expect(fromChild.complete).toBe(true)
        expect(fromChild.messages.map(m=>m.id)).toEqual([parent.id])
        expect(fromChild.messages.some(m=>m.id===ordinary.id)).toBe(false)
    })

    it('resolves legacy prompt and UUID ancestors, then loads the descendant conversation', () => {
        const f=setup()
        const parent=f.append(sdk('assistant','task-row',[task('legacy-task','Explore\n\nrepo')]))
        const root=f.append(sdk('user','legacy-root',[{type:'text',text:'Explore'},{type:'text',text:'repo'}],{isSidechain:true}))
        const child=f.append(sdk('assistant','legacy-child',[{type:'text',text:'Answer'}],{isSidechain:true,parentUuid:'legacy-root'}))
        const tail=f.append(sdk('assistant','legacy-tail',[{type:'text',text:'More'}],{isSidechain:true,parentUuid:'legacy-child'}))
        const ctx=f.store.messages.getMessageDependencyContext(f.session.id,[child.id],f.ready())
        expect(ctx.complete).toBe(true)
        expect(ctx.messages.map(m=>m.id)).toEqual([parent.id,root.id,tail.id])
    })

    it('respects the explicit parent tool over a coincident legacy prompt and does not expand that other Task', () => {
        const f=setup()
        const a=f.append(sdk('assistant','a',[task('task-a','Same prompt')]))
        const b=f.append(sdk('assistant','b',[task('task-b','Same prompt')]))
        const child=f.append(sdk('user','child','Same prompt',{isSidechain:true,parentToolUseId:'task-b'}))
        const ctx=f.store.messages.getMessageDependencyContext(f.session.id,[a.id],f.ready())
        expect(ctx.complete).toBe(true)
        expect(ctx.messages).toEqual([])
        expect(ctx.messages.some(m=>m.id===b.id||m.id===child.id)).toBe(false)
    })

    it('keeps ambiguous legacy selection explicit and follows the current last-prompt semantics', () => {
        const f=setup()
        const a=f.append(sdk('assistant','a',[task('task-a','Same prompt')]))
        const b=f.append(sdk('assistant','b',[task('task-b','Same prompt')]))
        const child=f.append(sdk('user','child','Same prompt',{isSidechain:true}))
        const ctx=f.store.messages.getMessageDependencyContext(f.session.id,[child.id],f.ready())
        expect(ctx.complete).toBe(false)
        expect(ctx.messages.map(m=>m.id)).toEqual([b.id])
        expect(ctx.messages.some(m=>m.id===a.id)).toBe(false)
        expect(ctx.issues.some(i=>i.reason==='ambiguous-parent')).toBe(true)
    })

    it('reads streams separately and reports an over-budget context instead of complete empty children', () => {
        const f=setup()
        const text=f.append(codex({type:'message',id:'shared-id',message:'Text'}))
        const thought=f.append(codex({type:'reasoning',id:'shared-id',message:'Thought'}))
        const textTail=f.append(codex({type:'message',id:'shared-id',message:'Text final'}))
        const epoch=f.ready()
        expect(f.store.messages.getMessageDependencyContext(f.session.id,[textTail.id],epoch).messages.map(m=>m.id)).toEqual([text.id])
        expect(f.store.messages.getMessageDependencyContext(f.session.id,[thought.id],epoch).messages).toEqual([])
        const bounded=getMessageDependencyContext(f.db,f.session.id,[textTail.id],epoch,{messages:0,queries:512,bytes:1024,timeMs:1000})
        expect(bounded.complete).toBe(false)
        expect(bounded.issues.some(i=>i.reason==='budget')).toBe(true)
        expect(bounded.pendingMessageIds).toContain(text.id)
    })

    it('checks every seed scope and resets changed epochs before returning dependency content', () => {
        const f=setup()
        const row=f.append(codex({type:'message',message:'text'}))
        const other=f.store.sessions.getOrCreateSession('foreign',null,null,'other')
        const foreign=f.store.messages.addMessage(other.id,codex({type:'message',message:'private'}))
        const epoch=f.ready()
        expect(()=>f.store.messages.getMessageDependencyContext(f.session.id,[row.id,foreign.id],epoch)).toThrow('History seed not found in session')
        f.store.messages.bumpMessageEpoch(f.session.id)
        const reset=f.store.messages.getMessageDependencyContext(f.session.id,[row.id],epoch)
        expect(reset.reset).toBe(true)
        expect(reset.messages).toEqual([])
        expect(reset.complete).toBe(false)
    })

    it('reports missing index coverage and unknown formats without invoking backfill during a read', () => {
        const f=setup()
        const row=f.append(codex({type:'message',message:'Text'}))
        const incomplete=f.store.messages.getMessageDependencyContext(f.session.id,[row.id],0)
        expect(incomplete.indexReady).toBe(false)
        expect(incomplete.complete).toBe(false)
        const unknown=f.append({role:'agent',content:{type:'future-producer',data:{id:'unknown'}}})
        const ctx=f.store.messages.getMessageDependencyContext(f.session.id,[unknown.id],f.ready())
        expect(ctx.indexReady).toBe(false)
        expect(ctx.issues.some(i=>i.reason==='unsupported')).toBe(true)
    })
    it('does not choose a seemingly unique legacy parent while index coverage is incomplete', () => {
        const f=setup()
        const parent=f.append(sdk('assistant','task-row',[task('legacy-task','Explore')]))
        const root=f.append(sdk('user','legacy-root','Explore',{isSidechain:true}))
        const context=f.store.messages.getMessageDependencyContext(f.session.id,[root.id],0)
        expect(context.indexReady).toBe(false)
        expect(context.complete).toBe(false)
        expect(context.messages.some(row=>row.id===parent.id)).toBe(false)
        expect(context.issues.some(issue=>issue.messageId===root.id&&issue.reason==='index-incomplete')).toBe(true)
    })

})


describe('large indexed dependency group continuation', () => {
    it('reads every record of a 701-record AgentRun without including another agent or session', () => {
        const f = setup()
        const saved = Array.from({ length: 701 }, (_, i) => f.append(codex({
            type: i === 0 ? 'agent-run-start' : 'agent-run-trace', agentId: 'large-agent', cardId: 'large-card',
            message: { type: 'message', message: `Step ${i}` },
        })))
        const otherAgent = f.append(codex({ type: 'agent-run-start', agentId: 'other-agent', cardId: 'other-card' }))
        const foreign = f.store.sessions.getOrCreateSession('foreign-card', null, null, 'other')
        f.store.messages.addMessage(foreign.id, codex({ type: 'agent-run-start', agentId: 'large-agent', cardId: 'large-card' }))
        f.ready()
        let cursor: MessageDependencyCandidateCursor | null = null
        const found: string[] = []
        const sizes: number[] = []
        do {
            const page = findMessageDependencyCandidatePage(f.db, f.session.id, 'agent_run_card', 'large-card', cursor)
            sizes.push(page.candidates.length)
            found.push(...page.candidates.map(row => row.id))
            cursor = page.nextCursor
        } while (cursor)
        expect(sizes).toEqual([200, 200, 200, 101])
        expect(found).toEqual(saved.map(row => row.id).sort())
        expect(new Set(found).size).toBe(701)
        expect(found).not.toContain(otherAgent.id)
    })

    it('continues inside a single stored row with more than 200 matching blocks', () => {
        const f = setup()
        const row = f.append(sdk('assistant', 'multi-block-row', Array.from({ length: 230 }, () => ({
            type: 'tool_use', id: 'repeated-tool-id', name: 'Bash', input: { command: 'pwd' },
        }))))
        f.ready()
        const first = findMessageDependencyCandidatePage(f.db, f.session.id, 'tool_call', 'repeated-tool-id')
        expect(first.candidates).toHaveLength(200)
        expect(first.nextCursor).toEqual({ messageId: row.id, ordinal: 199 })
        const second = findMessageDependencyCandidatePage(f.db, f.session.id, 'tool_call', 'repeated-tool-id', first.nextCursor)
        expect(second.candidates.map(candidate => candidate.ordinal)).toEqual(Array.from({ length: 30 }, (_, i) => i + 200))
        expect(second.nextCursor).toBeNull()
    })
})
