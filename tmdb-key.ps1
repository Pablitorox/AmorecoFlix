<#
  tmdb-key.ps1 - resolve a chave TMDB sem precisar passar -ApiKey toda vez.
  Ordem: parametro -ApiKey (se informado) -> $env:TMDB_API_KEY -> .env do projeto.

  Uso (logo apos o param() do script, com -ApiKey NAO mandatorio):
    . (Join-Path $PSScriptRoot 'tmdb-key.ps1')
    if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
    if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
#>
function Get-TmdbApiKey {
    if ($env:TMDB_API_KEY) { return $env:TMDB_API_KEY }
    $envFile = Join-Path $PSScriptRoot '.env'
    if (Test-Path -LiteralPath $envFile) {
        $line = Get-Content -LiteralPath $envFile -EA 0 | Where-Object { $_ -match '^\s*TMDB_API_KEY\s*=' } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }
    return $null
}
