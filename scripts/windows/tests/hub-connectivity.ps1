param(
    [string]$ConnectionFile = 'D:\hapi\config\connection.json',
    [int]$TimeoutSeconds = 10
)
# Run in the Runner's account/session before a Hub restart. Browser/system-proxy
# success does not establish the direct path used by the background Runner.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = Get-Content -LiteralPath $ConnectionFile -Raw | ConvertFrom-Json
$origin = [Uri]$config.hub
$report = [ordered]@{
    utc = [DateTime]::UtcNow.ToString('o')
    account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    sessionId = (Get-Process -Id $PID).SessionId
    host = $origin.DnsSafeHost
    path = 'direct (proxy disabled)'
    passed = $false
    stage = 'dns'
}
$handler = $null
$client = $null
$socket = $null
$cancel = $null
try {
    $addresses = [Net.Dns]::GetHostAddressesAsync($origin.DnsSafeHost).WaitAsync([TimeSpan]::FromSeconds($TimeoutSeconds)).GetAwaiter().GetResult()
    $report.addresses = @($addresses | ForEach-Object { $_.IPAddressToString })
    $report.stage = 'https'
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $response = $client.GetAsync($origin).GetAwaiter().GetResult()
    try {
        $report.httpStatus = [int]$response.StatusCode
        if ($report.httpStatus -ne 200) { throw 'Hub landing page did not return HTTP 200' }
    } finally { $response.Dispose() }
    $report.stage = 'websocket'
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.Proxy = $null
    $ws = [UriBuilder]::new($origin)
    $ws.Scheme = if ($origin.Scheme -eq 'https') { 'wss' } else { 'ws' }
    $ws.Path = '/socket.io/'
    $ws.Query = 'EIO=4&transport=websocket'
    $cancel = [Threading.CancellationTokenSource]::new($TimeoutSeconds * 1000)
    $socket.ConnectAsync($ws.Uri, $cancel.Token).GetAwaiter().GetResult() | Out-Null
    $report.websocket = $socket.State.ToString()
    if ($socket.State -ne [Net.WebSockets.WebSocketState]::Open) { throw 'WebSocket did not open' }
    $report.passed = $true
    $report.stage = 'complete'
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($socket) { $socket.Dispose() }
    if ($cancel) { $cancel.Dispose() }
    if ($client) { $client.Dispose() } elseif ($handler) { $handler.Dispose() }
}
$report | ConvertTo-Json -Depth 4 -Compress
if (!$report.passed) { exit 1 }
