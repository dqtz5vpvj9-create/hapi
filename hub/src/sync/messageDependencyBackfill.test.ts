import { afterEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { Store } from '../store'
import { MessageDependencyBackfill } from './messageDependencyBackfill'

const cleanups: Array<()=>void> = []
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()})
function fixture() {
    const store=new Store(':memory:')
    const db=(store as unknown as {db:Database}).db
    const errors:unknown[]=[]
    const worker=new MessageDependencyBackfill(store,(_id,error)=>errors.push(error))
    cleanups.push(()=>{worker.stop();store.close()})
    const history=(count:number)=>{
        const session=store.sessions.getOrCreateSession(randomUUID(),null,null,'reader')
        let seed=''
        const insert=db.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES (?,?,?,?,?,?)')
        db.transaction(()=>{for(let i=0;i<count;i++){
            seed=randomUUID()
            insert.run(seed,session.id,JSON.stringify({role:'user',content:{type:'text',text:`Legacy paragraph ${i}`}}),1000+i,i+1,1000+i)
        }})()
        const read=()=>store.messages.getMessageDependencyContext(session.id,[seed],store.messages.getMessageEpoch(session.id))
        return {session,read}
    }
    return {store,db,worker,errors,history}
}
async function until(predicate:()=>boolean) {
    const deadline=Date.now()+3000
    while(!predicate()&&Date.now()<deadline)await Bun.sleep(10)
    if(!predicate())throw new Error('Background history did not reach expected state')
}

describe('requested-history background dependency indexing',()=>{
    it('yields between batches so a short history becomes readable before a long history finishes',async()=>{
        const f=fixture(),long=f.history(4000),short=f.history(1)
        f.worker.request(long.session.id)
        f.worker.request(short.session.id)
        expect(short.read().indexScanned).toBe(false)
        await until(()=>short.read().indexScanned)
        expect(short.read().complete).toBe(true)
        expect(long.read().indexScanned).toBe(false)
        await until(()=>long.read().indexScanned)
        expect(long.read().complete).toBe(true)
        expect(f.errors).toEqual([])
    })

    it('stops pending work before closing the store instead of running callbacks on a closed database',async()=>{
        const f=fixture(),h=f.history(300)
        f.worker.request(h.session.id)
        f.worker.stop()
        await Bun.sleep(75)
        expect(h.read().indexScanned).toBe(false)
        expect(f.store.messages.backfillMessageDependencies(h.session.id).enumerated).toBeGreaterThan(0)
        expect(f.worker.request(h.session.id)).toBe(false)
        expect(f.errors).toEqual([])
    })

    it('rolls back a failed batch, does not spin, and can retry after the database failure is removed',async()=>{
        const f=fixture(),h=f.history(1)
        f.db.exec("CREATE TRIGGER fail_history_index BEFORE INSERT ON message_dependency_state BEGIN SELECT RAISE(ABORT,'index write unavailable'); END")
        f.worker.request(h.session.id)
        await until(()=>f.errors.length>0)
        await Bun.sleep(75)
        expect(f.errors).toHaveLength(1)
        expect(h.read().indexScanned).toBe(false)
        expect(f.db.prepare('SELECT * FROM message_dependency_scan WHERE session_id=?').get(h.session.id)).toBeNull()
        f.db.exec('DROP TRIGGER fail_history_index')
        f.worker.request(h.session.id)
        await until(()=>h.read().indexScanned)
        expect(h.read().complete).toBe(true)
        expect(f.errors).toHaveLength(1)
    })
})
