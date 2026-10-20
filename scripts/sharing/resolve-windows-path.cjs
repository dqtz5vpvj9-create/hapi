const fs = require('node:fs');
const path = require('node:path');
try {
 const requested = Buffer.from(process.argv[2], 'base64url').toString('utf8');
 let cursor = path.resolve(requested);
 const tail = [];
 while (true) {
  try {
   fs.lstatSync(cursor);
   const canonical = fs.realpathSync.native(cursor);
   process.stdout.write(JSON.stringify({path:path.resolve(canonical,...tail),exists:tail.length===0}));
   break;
  } catch(error) {
   if (error.code !== 'ENOENT' || fs.existsSync(cursor) || path.dirname(cursor)===cursor) throw error;
   // A dangling link must not be accepted as a new directory.
   try { fs.lstatSync(cursor); throw new Error('Unresolved link'); } catch(e) { if(e.code!=='ENOENT') throw e; }
   tail.unshift(path.basename(cursor));cursor=path.dirname(cursor);
  }
 }
} catch(e) { console.error(e.message); process.exitCode=1; }
