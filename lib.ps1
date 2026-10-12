<#
  lib.ps1 - funcoes comuns dos scripts do PC (dot-source logo apos o param()):
    . (Join-Path $PSScriptRoot 'lib.ps1')

  Get-EnvValue NOME   -> variavel de ambiente, senao a linha NOME=... do .env do projeto
  Get-TmdbApiKey      -> chave TMDB ($env:TMDB_API_KEY ou .env)
  Find-FfTool nome    -> caminho do ffmpeg/ffprobe (PATH ou instalacao do winget Gyan.FFmpeg)

  Uso tipico da chave (com -ApiKey NAO mandatorio):
    if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
    if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
#>

function Get-EnvValue($name) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v) { return $v }
    $f = Join-Path $PSScriptRoot '.env'
    if (Test-Path -LiteralPath $f) {
        $l = Get-Content -LiteralPath $f -EA 0 | Where-Object { $_ -match ('^\s*' + $name + '\s*=') } | Select-Object -First 1
        if ($l) { return (($l -split '=', 2)[1]).Trim().Trim('"') }
    }
    return $null
}

function Get-TmdbApiKey { return (Get-EnvValue 'TMDB_API_KEY') }

$script:FfToolCache = @{}
function Find-FfTool([string]$name) {
    if ($script:FfToolCache.ContainsKey($name)) { return $script:FfToolCache[$name] }
    $p = (Get-Command $name -EA 0).Source
    if (-not $p) {
        $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter "$name.exe" -EA 0 | Select-Object -First 1
        if ($b) { $p = $b.FullName }
    }
    $script:FfToolCache[$name] = $p
    return $p
}
