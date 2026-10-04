$ErrorActionPreference='Stop'
$env:TEMP='D:\hapi\temp'
$env:TMP=$env:TEMP
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Threading.Tasks;
public static class HapiNativePipe {
 static void Log(string s) { lock(typeof(HapiNativePipe)) File.AppendAllText(@"D:\hapi\logs\pipe.log",DateTime.UtcNow.ToString("O")+" "+s+"\n"); }
 public static async Task Run(string socketPath) {
  Log("started");
  while(true) {
   var pipe=new NamedPipeServerStream("hapi-native-preview-20261004",PipeDirection.InOut,20,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
   await pipe.WaitForConnectionAsync();
   _=Relay(pipe,socketPath);
  }
 }
 static async Task Relay(NamedPipeServerStream pipe,string path) {
  using(pipe) using(var socket=new Socket(AddressFamily.Unix,SocketType.Stream,ProtocolType.Unspecified)) {
   try {
    await socket.ConnectAsync(new UnixDomainSocketEndPoint(path));
    Log("connected");
    using(var stream=new NetworkStream(socket,false)) {
     var up=pipe.CopyToAsync(stream); var down=stream.CopyToAsync(pipe);
     await Task.WhenAny(up,down);
     pipe.Dispose();socket.Dispose();
     try {await Task.WhenAll(up,down);} catch(IOException) {} catch(ObjectDisposedException) {} catch(SocketException) {}
    }
    Log("closed");
   } catch(Exception e) {Log("error "+e.GetType().Name+" "+e.Message);}
  }
 }
}
'@
[HapiNativePipe]::Run((Join-Path $env:USERPROFILE '.codex\app-server-control\app-server-control.sock')).GetAwaiter().GetResult()
