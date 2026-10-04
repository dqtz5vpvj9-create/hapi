import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {api,machineId} from './hub.mjs';
const run=promisify(execFile);const dir=process.env.HAPI_ACCEPTANCE_DIR;
if (!dir) throw Error('Set HAPI_ACCEPTANCE_DIR');
fs.mkdirSync(dir,{recursive:true});
const sshHost=process.env.HAPI_WINDOWS_SSH || 'Lis-iMac';
async function remote(script,args='') {const r=await run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','LogLevel=ERROR',sshHost,`pwsh.exe -NoLogo -NoProfile -NonInteractive -File D:/hapi/scripts/${script}.ps1${args}`],{timeout:25000});return JSON.parse(r.stdout)}
const spawn=await api(`machines/${machineId}/spawn`,{directory:'D:\\hapi\\workspaces',agent:'codex',model:'gpt-6.1-sol',modelReasoningEffort:'low',serviceTier:'standard',sessionType:'simple',permissionMode:'read-only'});
if(!spawn.sessionId)throw Error('Spawn failed: '+JSON.stringify(spawn));
const id=spawn.sessionId;const before=(await api('sessions/'+id)).session;
const result={id,nativeId:before.metadata.codexSessionId,hostPid:before.metadata.hostPid,checks:[]};fs.writeFileSync(dir+'/runner-survival.json',JSON.stringify(result,null,2));
for(const [script,args] of [['fault',' -Role runner'],['fault-runner-process','']]) {
 const fault=await remote(script,args);await new Promise(r=>setTimeout(r,10000));
 const after=(await api('sessions/'+id)).session;
 if(!after.active||after.metadata.hostPid!==result.hostPid||after.metadata.codexSessionId!==result.nativeId) throw Error('Existing session did not survive runner fault');
 const state=await remote('health-state');
 if(!state.processes.some(p=>p.pid===result.hostPid))throw Error('Session process exited');
 result.checks.push({fault,sessionPidUnchanged:true,nativeIdUnchanged:true});
 fs.writeFileSync(dir+'/runner-survival.json',JSON.stringify(result,null,2));
}
await api('sessions/'+id+'/messages',{text:'Reply exactly HAPI_RUNNER_SURVIVAL_OK. Do not use tools or modify files.',localId:'ha-runner-survival-once'});
const start=Date.now();let replied=false;
while(Date.now()-start<60000){await new Promise(r=>setTimeout(r,2000));const history=await api('sessions/'+id+'/messages?limit=30');const text=JSON.stringify(history.messages);if(text.includes('"message":"HAPI_RUNNER_SURVIVAL_OK"')||text.includes('"text":"HAPI_RUNNER_SURVIVAL_OK"')){replied=true;break;}}
result.replyAfterRunnerRestart=replied;fs.writeFileSync(dir+'/runner-survival.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!replied)throw Error('No reply after runner restart');
