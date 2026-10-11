// Synthetic fixture diagnostic only. Lean mode records no per-frame DOM geometry.
export function installHistoryProbe(options) {
    const state={mode:options.mode,target:options.target,historyCount:options.historyCount,activationAt:null,activationType:null,clickAt:null,firstDeclaredAt:null,firstCorrectAt:null,frames:[],wheels:[],longTasks:[],snapshots:[],dropped:0,stopped:false}
    let raf=0,observer=null
    state.geometry=[];state.geometryDropped=0
    function geometry(reason,extra={}){
        if(state.activationAt===null||state.stopped)return
        const began=performance.now(),view=document.querySelector('.hapi-native-thread .chat-scroll-y'),thread=view?.closest('.hapi-native-thread'),content=view?.querySelector('[data-chat-presented]'),list=view?.querySelector('[data-hapi-list-count]')
        const value={at:began,reason,...extra,presented:content?.getAttribute('data-chat-presented')??null,followingTail:thread?.getAttribute('data-following-tail')??null,logicalRows:Number(list?.getAttribute('data-hapi-list-count')??0),mountedRows:list?.querySelectorAll('[data-hapi-virtual-message]').length??0,scrollTop:view?.scrollTop??null,scrollHeight:view?.scrollHeight??null,clientHeight:view?.clientHeight??null,overflowAnchorInline:view?.style.overflowAnchor??null}
        value.floor=value.scrollHeight===null?null:Math.max(0,value.scrollHeight-value.clientHeight);value.workMs=performance.now()-began
        if(state.geometry.length<1200)state.geometry.push(value);else state.geometryDropped++
    }
    document.addEventListener('wheel',event=>{if(state.activationAt===null||state.stopped)return;const extra={deltaY:event.deltaY,eventAt:event.timeStamp,trusted:event.isTrusted};geometry('wheel-capture',extra);queueMicrotask(()=>geometry('wheel-microtask',extra));requestAnimationFrame(()=>geometry('wheel-next-raf',extra))},{capture:true,passive:true})
    document.addEventListener('scroll',event=>{if(event.target?.matches?.('.chat-scroll-y'))geometry('native-scroll',{trusted:event.isTrusted})},{capture:true,passive:true})
    const geometryObserver=new MutationObserver(records=>{if(records.some(r=>r.type==='attributes'))geometry('publication-mutation',{attributes:[...new Set(records.map(r=>r.attributeName).filter(Boolean))]})})
    geometryObserver.observe(document,{subtree:true,attributes:true,attributeFilter:['data-chat-presented','data-following-tail','data-hapi-list-count']})
    const rect=element=>{const r=element.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    function sample(){
        const began=performance.now(),view=[...document.querySelectorAll('.chat-scroll-y')].find(el=>el.clientHeight>0),content=view?.querySelector('[data-chat-presented]'),list=view?.querySelector('[data-hapi-list-count]')
        if(!view||!content||!list)return{at:began,correct:false,phase:'not-mounted',errors:['chat body/list absent'],workMs:performance.now()-began}
        const bounds=rect(view),presented=content.getAttribute('data-chat-presented')==='true'&&content.getAttribute('aria-hidden')!=='true'&&getComputedStyle(content).visibility!=='hidden'&&!view.closest('.hapi-native-thread')?.querySelector('[data-chat-opening]')
        if(!presented)return{at:began,correct:false,phase:'opening',errors:['chat not presented'],bounds,workMs:performance.now()-began}
        const listBounds=rect(list),rows=[],errors=[],intervals=[]
        for(const el of list.querySelectorAll('[data-hapi-virtual-message]')){
            const r=rect(el);if(r.height<=0||r.bottom<=bounds.top||r.top>=bounds.bottom)continue
            const text=el.innerText,match=text.match(/chat-(\d+)\s*·\s*(问题|记录)\s*(\d+)/),seq=match?Number(match[3]):null
            if(!match||'chat-'+match[1]!==options.target)errors.push('missing-or-wrong-body:'+el.dataset.hapiVirtualMessage)
            if(seq!==null&&(seq<1||seq>options.historyCount||(seq%2===1)!==(match[2]==='问题')))errors.push('sequence-or-role:'+seq)
            const body=el.querySelector('.happy-message[data-hapi-message-role]'),kind=seq!==null&&seq%2===1?'user-text':'agent-text',expectedKey=seq===null?null:`${kind}:${options.target}:${options.target}-turn-${Math.ceil(seq/2)}:${options.target}-${seq}:${kind}`
            if(!body||body.dataset.hapiMessageRole!==(kind==='user-text'?'user':'assistant'))errors.push('missing-or-wrong-role:'+seq)
            if(expectedKey&&el.dataset.hapiVirtualMessage!==expectedKey)errors.push('wrong-canonical-key:'+seq)
            rows.push({id:el.dataset.hapiVirtualMessage,seq,kind:match?.[2]??null,top:r.top,bottom:r.bottom,text:text.slice(0,400)})
            intervals.push([Math.max(r.top,bounds.top),Math.min(r.bottom,bounds.bottom)])
        }
        for(let i=1;i<rows.length;i++)if(rows[i].seq!==null&&rows[i-1].seq!==null&&rows[i].seq<=rows[i-1].seq)errors.push('nonascending-sequence')
        const start=Math.max(bounds.top,listBounds.top),end=Math.min(bounds.bottom,listBounds.bottom);let covered=start
        for(const [top,bottom] of intervals.sort((a,b)=>a[0]-b[0])){if(top-covered>6)errors.push('blank:'+Math.round(top-covered));covered=Math.max(covered,bottom)}
        if(end-covered>6)errors.push('blank-end:'+Math.round(end-covered))
        if(!rows.length)errors.push('no-visible-body')
        return{at:began,correct:errors.length===0,phase:'presented',errors,bounds,rows,scrollTop:view.scrollTop,scrollHeight:view.scrollHeight,maxScrollTop:view.scrollHeight-view.clientHeight,mountedRows:list.querySelectorAll('[data-hapi-virtual-message]').length,logicalRenderedRows:Number(list.dataset.hapiListCount),domNodes:content.querySelectorAll('*').length,workMs:performance.now()-began}
    }
    const frame=at=>{if(state.stopped)return;geometry("raf");if(state.frames.length<1000)state.frames.push(at);else state.dropped++;if(options.mode==='full'&&state.snapshots.length<600){const value=sample();state.snapshots.push(value);if(value.correct&&state.firstCorrectAt===null)state.firstCorrectAt=value.at}raf=requestAnimationFrame(frame)}
    document.addEventListener('mouseup',event=>{const row=event.target?.closest?.('[data-session-tree-id]');if(!event.isTrusted||event.button!==0||row?.dataset.sessionTreeId!==options.target||state.activationAt!==null)return;state.activationAt=performance.now();state.activationType='trusted target-row mouseup (production onMouseUp navigation)';raf=requestAnimationFrame(frame)},{capture:true,passive:true})
    document.addEventListener('click',event=>{if(event.isTrusted&&event.target?.closest?.('[data-session-tree-id]')?.dataset.sessionTreeId===options.target&&state.clickAt===null)state.clickAt=performance.now()},{capture:true,passive:true})
    document.addEventListener('wheel',event=>{if(state.activationAt===null||state.stopped)return;const view=event.target?.closest?.('.chat-scroll-y'),oldList=event.target?.closest?.('.app-session-list-content');const content=view?.querySelector('[data-chat-presented]');if(state.wheels.length<300)state.wheels.push({at:performance.now(),eventAt:event.timeStamp,deltaY:event.deltaY,trusted:event.isTrusted,recipient:view?'chat':oldList?'old-session-list':'other',presented:content?.getAttribute('data-chat-presented')==='true',targetTag:event.target?.tagName,targetClass:String(event.target?.className??'').slice(0,160)});else state.dropped++},{capture:true,passive:true})
    try{new PerformanceObserver(entries=>{for(const e of entries.getEntries())if(state.longTasks.length<500)state.longTasks.push({at:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch(error){state.longTaskError=String(error)}
    observer=new MutationObserver(()=>{if(state.activationAt===null||state.firstDeclaredAt!==null)return;const content=document.querySelector('.chat-scroll-y [data-chat-presented="true"]');if(content){state.firstDeclaredAt=performance.now();observer.disconnect()}})
    observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['data-chat-presented']})
    window.__longHistoryProbe={peek:()=>({activationAt:state.activationAt,firstDeclaredAt:state.firstDeclaredAt,firstCorrectAt:state.firstCorrectAt,sample:sample()}),stop(){geometry("stop");geometryObserver.disconnect();state.stopped=true;cancelAnimationFrame(raf);observer.disconnect();state.final=sample();return state}}
}
