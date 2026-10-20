function Resolve-HapiCodex {
    # The desktop updater installs immutable version directories. Resolve on each
    # child launch rather than hard-coding the directory from installation day.
    $root = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $candidates = @(Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
        $executable = Join-Path $_.FullName 'codex.exe'
        $hostExecutable = Join-Path $_.FullName 'codex-code-mode-host.exe'
        if ((Test-Path -LiteralPath $executable -PathType Leaf) -and
            (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
            Get-Item -LiteralPath $executable
        }
    } | Sort-Object LastWriteTimeUtc -Descending)
    if ($candidates.Count -gt 0) { return $candidates[0].FullName }
    throw 'No complete desktop Codex installation with code-mode host found'
}
