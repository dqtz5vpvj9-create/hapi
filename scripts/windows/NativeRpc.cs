using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

// A local protocol probe, not a model request. Same-user pipe ACLs still apply.
public sealed class HapiNativeRpc : IDisposable {
    readonly ClientWebSocket socket = new ClientWebSocket();
    HttpMessageInvoker http;
    int sequence;
    public static async Task<HapiNativeRpc> Connect(string pipeName) {
        var client = new HapiNativeRpc();
        var handler = new SocketsHttpHandler { UseProxy = false };
        handler.ConnectCallback = async (context, cancellation) => {
            var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try { await pipe.ConnectAsync(cancellation); return pipe; }
            catch { pipe.Dispose(); throw; }
        };
        client.http = new HttpMessageInvoker(handler);
        try {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                await client.socket.ConnectAsync(new Uri("ws://localhost/rpc"), client.http, timeout.Token);
            await client.Request("initialize", "{\"clientInfo\":{\"name\":\"hapi_windows_supervisor\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}");
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                await client.socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes("{\"method\":\"initialized\"}")), WebSocketMessageType.Text, true, timeout.Token);
            return client;
        } catch { client.Dispose(); throw; }
    }
    public async Task<string> Request(string method, string parameters) {
        int id = ++sequence;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var request = "{\"id\":" + id + ",\"method\":" + JsonSerializer.Serialize(method) + ",\"params\":" + parameters + "}";
        await socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(request)), WebSocketMessageType.Text, true, timeout.Token);
        var buffer = new byte[8192];
        while (true) {
            using var message = new MemoryStream();
            WebSocketReceiveResult frame;
            do {
                frame = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), timeout.Token);
                if (frame.MessageType == WebSocketMessageType.Close) throw new IOException("Native server closed the connection");
                message.Write(buffer, 0, frame.Count);
            } while (!frame.EndOfMessage);
            using var document = JsonDocument.Parse(message.ToArray());
            var root = document.RootElement;
            // The supervisor does not handle thread permissions or tool requests.
            // It only restores subscriptions; HAPI/desktop own user interaction.
            if (!root.TryGetProperty("id", out var responseId) || responseId.ValueKind != JsonValueKind.Number || !responseId.TryGetInt32(out var number) || number != id || root.TryGetProperty("method", out _)) continue;
            if (root.TryGetProperty("error", out var error)) throw new IOException(error.ToString());
            return root.GetProperty("result").GetRawText();
        }
    }
    public void Dispose() { socket.Dispose(); http?.Dispose(); }
}
