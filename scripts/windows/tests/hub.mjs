const credential = process.env.CLI_API_TOKEN;
export const base = process.env.HAPI_API_URL;
if (!credential || !base) throw Error('Set CLI_API_TOKEN and HAPI_API_URL for the acceptance Hub');
const auth = await fetch(base+'/api/auth', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessToken:credential}),signal:AbortSignal.timeout(15000)});
const {token} = await auth.json(); if(!token) throw Error('Hub authentication failed');
export async function api(path, body, method=body===undefined?'GET':'POST') {
    const response = await fetch(base+'/api/'+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    if(!response.ok) throw Error('HTTP '+response.status+' '+(await response.text()).slice(0,250));
    return response.json();
}
export const machineId=process.env.HAPI_WINDOWS_MACHINE_ID;
export const originalSession=process.env.HAPI_WINDOWS_SESSION_ID;
if (!machineId || !originalSession) throw Error('Set HAPI_WINDOWS_MACHINE_ID and HAPI_WINDOWS_SESSION_ID');
export async function check() {
    const started=Date.now();
    const machines=await api('machines');
    const machine=machines.machines.find(m=>m.id===machineId);
    const result=await api('sessions/'+originalSession);
    const session=result.session ?? result;
    const history=await api('sessions/'+originalSession+'/messages?limit=30');
    return {at:new Date().toISOString(),machineId,machineOnline:machine?.active,sessionId:session.id,sessionActive:session.active,nativeId:session.metadata?.codexSessionId,messages:history.messages.length,elapsedMs:Date.now()-started};
}
