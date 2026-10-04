import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {check} from './hub.mjs';
const run=promisify(execFile);
const directory=process.env.HAPI_ACCEPTANCE_DIR;
if (!directory) throw Error('Set HAPI_ACCEPTANCE_DIR to an artifact directory on the cache disk');
fs.mkdirSync(directory,{recursive:true});
async function remote(file,args='') {
    const {stdout}=await run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','LogLevel=ERROR',process.env.HAPI_WINDOWS_SSH ?? 'Lis-iMac',`pwsh.exe -NoLogo -NoProfile -NonInteractive -File D:/hapi/scripts/${file}.ps1${args}`],{timeout:25000});
    return JSON.parse(stdout);
}
const results=[];
for(const role of ['engine','native','runner','supervisor']) {
    const before=await check();
    const fault=await remote('fault',` -Role ${role}`);
    const start=Date.now(); let error; let passed=false;
    while(Date.now()-start<110000) {
        await new Promise(resolve=>setTimeout(resolve,2000));
        try {
            const live=await remote('health-state');
            const state=live.state;
            const pid=role==='supervisor'?state.pid:state.roles[role]?.pid;
            if(!pid||pid===fault.oldPid||!state.nativeReady||state.restorePending||Date.now()-Date.parse(state.timestamp)>15000) continue;
            const engines=live.processes.filter(p=>p.name==='codex.exe');
            if(engines.length!==1||!engines[0].listens||engines[0].session!==0) throw Error('Unexpected engine topology');
            if(live.processes.filter(p=>p.role==='runner').length!==1||live.processes.filter(p=>p.role==='native').length!==1) throw Error('Duplicate or missing HAPI role');
            const after=await check();
            if(!after.machineOnline||!after.sessionActive||after.nativeId!==before.nativeId||after.messages!==before.messages) throw Error('Session or history did not recover');
            const result={role,passed:true,recoveryMs:Date.now()-start,fault,before,after,live};
            results.push(result); console.log(JSON.stringify({role,passed:true,recoveryMs:result.recoveryMs,messages:after.messages})); passed=true; break;
        }catch(e){error=e.message;}
    }
    if(!passed){results.push({role,passed:false,error});console.log(JSON.stringify(results.at(-1)));}
    fs.writeFileSync(directory+'/fault-matrix.json',JSON.stringify(results,null,2));
    if(!passed) throw Error('Fault acceptance failed: '+role);
}
