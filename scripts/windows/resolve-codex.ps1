function Resolve-HapiCodex {
    # The desktop updater installs immutable version directories. Resolve on each
    # child launch rather than hard-coding the directory from installation day.
    $root = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $candidates = @(Get-ChildItem -LiteralPath $root -Directory | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($candidate in $candidates) {
        $executable = Join-Path $candidate.FullName 'codex.exe'
        if (Test-Path -LiteralPath $executable -PathType Leaf) { return $executable }
    }
    throw 'No installed desktop Codex executable found'
}
