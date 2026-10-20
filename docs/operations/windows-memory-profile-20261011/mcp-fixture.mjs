import fs from 'node:fs';
import readline from 'node:readline';
const marker = process.argv[2];
function mark(method) { fs.appendFileSync(marker, JSON.stringify({pid:process.pid,method,utc:new Date().toISOString()})+'\n'); }
mark('process-start');
for await (const line of readline.createInterface({input:process.stdin})) {
 let request; try {request=JSON.parse(line)} catch {continue}
 mark(request.method);
 if(request.id === undefined) continue;
 const result=request.method==='initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hapi-memory-fixture',version:'1'}} : request.method==='tools/list' ? {tools:[{name:'no_op',description:'Profiling only; never invoked',inputSchema:{type:'object',properties:{}}}]} : {};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
mark('stdin-closed');
