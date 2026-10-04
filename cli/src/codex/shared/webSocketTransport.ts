import WebSocket from 'ws';
import NodeWebSocket from 'ws-node';

/** Bun's ws replacement cannot open Windows named pipes. Use npm ws there. */
export function openCodexWebSocket(url: string, options: WebSocket.ClientOptions): WebSocket {
    const Client = process.platform === 'win32' && url.startsWith('ws+unix://')
        ? NodeWebSocket
        : WebSocket;
    return new Client(url, options);
}
