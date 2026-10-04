/** Compile with Bun for Windows; pass the endpoint of a running local Codex named-pipe relay. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openCodexWebSocket } from '../src/codex/shared/webSocketTransport';

if (process.platform !== 'win32') throw new Error('Run this smoke test on Windows');
const endpoint = process.argv[2];
if (!endpoint?.startsWith('ws+unix://')) throw new Error('Pass the local Codex named-pipe endpoint');
for (let attempt = 0; attempt < 2; attempt++) {
    const socket = openCodexWebSocket(endpoint, { headers: { Host: 'localhost' }, handshakeTimeout: 5000 });
    try {
        await once(socket, 'open');
        const response = once(socket, 'message');
        socket.send(JSON.stringify({ id: attempt, method: 'initialize', params: {
            clientInfo: { name: 'hapi_windows_transport_test', title: 'Windows 传输验收', version: '1' },
            capabilities: { experimentalApi: true }
        } }));
        const [received] = await response;
        const message = JSON.parse(received.toString());
        assert.equal(message.id, attempt);
        assert.equal(message.error, undefined);
        assert.equal(typeof message.result.userAgent, 'string');
    } finally {
        const closed = once(socket, 'close');
        socket.close();
        await closed;
    }
}
console.log('PASS: Windows named-pipe handshake, Codex initialize response, reconnect');
