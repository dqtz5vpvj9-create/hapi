/** Real native/Hub startup, with an isolated CODEX_HOME supplied by the operator.
 * Never submits model input. Archives only the freshly created test root.
 * HAPI_CLI_EXECUTABLE must point to a normal HAPI binary for its stdio MCP bridge.
 */
import { runSharedRuntime } from '../src/codex/shared/runtime';
import { CodexAppServerClient } from '../src/codex/codexAppServerClient';
import { initializeSharedClient } from '../src/codex/shared/launch';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.env.HAPI_PROFILE_SESSION_STARTUP !== '1' || !process.env.CODEX_HOME || !process.env.HAPI_HOME) {
    throw new Error('Explicit profiling opt-in and isolated CODEX_HOME/HAPI_HOME are required');
}
const abort = new AbortController();
// Isolate the Runner acknowledgement endpoint as well as runtime ownership.
// This exercises the HTTP notifier, not production Runner admission/load.
const runner = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
});
await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
await writeFile(join(process.env.HAPI_HOME, 'runner.state.json'), JSON.stringify({ pid: process.pid,
    httpPort: (runner.address() as { port: number }).port }), { flag: 'wx' });
let cleanup: Promise<void> = Promise.resolve();
try { await runSharedRuntime({ workingDirectory: process.cwd(), startedBy: 'terminal' }, ready => {
    process.stdout.write(`${JSON.stringify({ event: 'ready', sessionId: ready.sessionId })}\n`);
    cleanup = (async () => {
        const client = new CodexAppServerClient({ endpoint: ready.runtime.endpoint, token: ready.runtime.token });
        try {
            await initializeSharedClient(client);
            await client.request('hapi/stopSession', { sessionId: ready.sessionId });
        } finally {
            await client.disconnect();
        }
    })();
    // A cleanup failure cancels only this runtime, which owns its private engine.
    void cleanup.catch(() => abort.abort());
}, abort.signal);
await cleanup;
process.stdout.write(`${JSON.stringify({ event: 'completed' })}\n`);
} finally {
    await new Promise<void>(resolve => runner.close(() => resolve()));
}
