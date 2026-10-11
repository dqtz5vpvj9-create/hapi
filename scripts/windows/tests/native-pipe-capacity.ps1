param(
    [string]$PipeName = 'hapi-native-preview-20261004',
    [ValidateRange(21, 64)][int]$Connections = 24
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot '..\NativeRpc.cs')
$clients = [Collections.Generic.List[HapiNativeRpc]]::new()
try {
    # Keep more than the former 20-instance limit open together. These clients
    # only initialize and read loaded IDs; they never resume or submit a turn.
    for ($index = 0; $index -lt $Connections; $index++) {
        $clients.Add([HapiNativeRpc]::Connect($PipeName).GetAwaiter().GetResult())
    }
    $null = $clients[0].Request('thread/loaded/list', '{}').GetAwaiter().GetResult()
    $null = $clients[$clients.Count - 1].Request('thread/loaded/list', '{}').GetAwaiter().GetResult()
    $clients[0].Dispose()
    $clients.RemoveAt(0)
    $clients.Add([HapiNativeRpc]::Connect($PipeName).GetAwaiter().GetResult())
    @{ passed = $true; simultaneousConnections = $Connections; reconnect = $true } | ConvertTo-Json -Compress
} finally {
    foreach ($client in $clients) { $client.Dispose() }
}
