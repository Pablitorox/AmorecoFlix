<#
  calendario-lancamentos.ps1 - gera os dados pro site local calendario.html:
  calendario semanal de lancamentos (Series + Animes da biblioteca),
  separado por streaming.

  Pra cada pasta de <Root>\Series e <Root>\Animes:
    - acha o id TMDB (mesma logica de match de posters-pastas.ps1)
    - pega proximo/ultimo episodio (/tv/{id}) e os streamings BR (/watch/providers)
  Salva tudo (+ a propria ApiKey, pra pagina poder atualizar sozinha) em
  <OutDir>\calendario-data.js.

  calendario.html (na mesma pasta) carrega esse arquivo e, toda vez que voce
  abre a pagina no navegador, RE-CONSULTA a TMDB pelos ids ja resolvidos -
  entao um episodio "Previsto" vira "Lancado" sozinho quando a data passa,
  sem precisar rodar este script de novo. So rode de novo quando adicionar
  uma serie/anime NOVO na biblioteca.

  Uso:
    .\calendario-lancamentos.ps1 -ApiKey SUA_CHAVE
#>
param(
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [string]$Root   = 'E:\AmorecoFlix',
    [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# abreviacoes / correcoes de nome p/ busca (mesmas de posters-pastas.ps1)
$ALIAS = @{
    'fma brotherhood' = 'Fullmetal Alchemist Brotherhood'
    'fma'              = 'Fullmetal Alchemist'
    'hxh'              = 'Hunter x Hunter'
    'aot'              = 'Attack on Titan'
    'snk'              = 'Attack on Titan'
}

function Norm($s) {
    $s = "$s".ToLower()
    $s = $s -replace '(\d)\s*[ºª°]','$1' -replace '[ºª°]',''
    $s = $s -replace '\b\d+\s*(a|ª)?\s*temporada\b','' -replace '\bseason\s*\d+\b',''
    $s = $s -replace '[:\-–—_.,]',' ' -replace '[^\p{Ll}\p{Nd} ]',''
    ($s -replace '\s+',' ').Trim()
}

function WordOverlap($qn, $nm) {
    $qw = @($qn -split ' ' | Where-Object { $_.Length -ge 2 })
    $nw = @($nm -split ' ' | Where-Object { $_.Length -ge 2 })
    if ($nw.Count -eq 0) { return 0 }
    $common = ($nw | Where-Object { $qw -contains $_ }).Count
    return [double]$common / $nw.Count
}

# acha o show na TMDB pelo nome da pasta (id + nome), sem baixar poster
function Find-Show($folderName) {
    $base = ($folderName -replace '\s*[-–]\s*\d+\s*(a|ª)?\s*Temporada\s*$','' `
                         -replace '\s*\d+\s*(a|ª)?\s*Temporada\s*$','').Trim()
    $key  = Norm $base
    $queries = @()
    if ($ALIAS.ContainsKey($key)) { $queries += $ALIAS[$key] }
    $queries += $base
    $queries += ($base -replace '\s+\d+\s*$','')
    $queries = $queries | Where-Object { $_ -and $_.Trim().Length -ge 2 } | Select-Object -Unique

    $best = $null; $bestScore = -1e9; $bestOv = 0
    foreach ($q in $queries) {
        $qn = Norm $q
        $url = "https://api.themoviedb.org/3/search/tv?api_key=$ApiKey&language=pt-BR&query=" + [uri]::EscapeDataString($q)
        try { $r = Invoke-RestMethod $url -TimeoutSec 20 } catch { continue }
        foreach ($h in ($r.results | Select-Object -First 6)) {
            $hn = $h.name; if (-not $hn) { $hn = '' }
            $ho = $h.original_name; if (-not $ho) { $ho = '' }
            $ov = [Math]::Max((WordOverlap $qn (Norm $hn)), (WordOverlap $qn (Norm $ho)))
            $sc = ($ov * 4000) + [double]$h.popularity
            if ((Norm $hn) -eq $qn -or (Norm $ho) -eq $qn) { $sc += 3000 }
            if ($sc -gt $bestScore) { $bestScore = $sc; $best = $h; $bestOv = $ov }
        }
        if ($best -and $bestOv -ge 0.8) { break }
        Start-Sleep -Milliseconds 150
    }
    if ($best -and $bestOv -ge 0.34) { return $best }
    return $null
}

function Get-ShowDetails($id) {
    $url = "https://api.themoviedb.org/3/tv/$id`?api_key=$ApiKey&language=pt-BR"
    try { return Invoke-RestMethod $url -TimeoutSec 20 } catch { return $null }
}

# provedores de streaming (regiao BR): assinatura primeiro, senao gratis/anuncios
function Get-Providers($id) {
    $url = "https://api.themoviedb.org/3/tv/$id/watch/providers?api_key=$ApiKey"
    try { $r = Invoke-RestMethod $url -TimeoutSec 20 } catch { return @() }
    $br = $r.results.BR
    if (-not $br) { return @() }
    $list = $br.flatrate
    if (-not $list -or $list.Count -eq 0) { $list = $br.free }
    if (-not $list -or $list.Count -eq 0) { $list = $br.ads }
    if (-not $list) { return @() }
    return @($list | ForEach-Object { [pscustomobject]@{ name = $_.provider_name; logo_path = $_.logo_path } })
}

function Get-EpisodeObj($ep) {
    if (-not $ep) { return $null }
    [pscustomobject]@{
        season_number  = $ep.season_number
        episode_number = $ep.episode_number
        name           = $ep.name
        air_date       = $ep.air_date
    }
}

# poster w500 (pra pagina montar a capa via image.tmdb.org, sem depender do HD estar plugado)
function Get-Poster($details, $hit) {
    if ($details -and $details.poster_path) { return $details.poster_path }
    if ($hit.poster_path) { return $hit.poster_path }
    return $null
}

$shows = @()
$ok = 0; $miss = 0

foreach ($cat in 'Series','Animes') {
    $dir = Join-Path $Root $cat
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Write-Host "== $cat ==" -ForegroundColor Cyan
    foreach ($showDir in (Get-ChildItem -LiteralPath $dir -Directory)) {
        $hit = Find-Show $showDir.Name
        if (-not $hit) { Write-Host "  ? $($showDir.Name)" -ForegroundColor Yellow; $miss++; continue }

        $details   = Get-ShowDetails $hit.id
        $providers = Get-Providers $hit.id
        Start-Sleep -Milliseconds 200

        $entry = [pscustomobject]@{
            folder       = $showDir.Name
            category     = $cat
            tmdb_id      = $hit.id
            name         = if ($details -and $details.name) { $details.name } else { $hit.name }
            status       = if ($details) { $details.status } else { $null }
            poster_path  = Get-Poster $details $hit
            providers    = $providers
            next_episode = if ($details) { Get-EpisodeObj $details.next_episode_to_air } else { $null }
            last_episode = if ($details) { Get-EpisodeObj $details.last_episode_to_air } else { $null }
        }
        $shows += $entry
        $ok++
        $provNames = if ($providers.Count) { ($providers | ForEach-Object { $_.name }) -join ', ' } else { '-' }
        Write-Host ("  OK  {0}  ->  {1}  [{2}]" -f $showDir.Name, $entry.name, $provNames)
    }
}

$out = [pscustomobject]@{
    generated_at = (Get-Date).ToString('o')
    apiKey       = $ApiKey
    shows        = $shows
}
$jsFile = Join-Path $OutDir 'calendario-data.js'
$json = $out | ConvertTo-Json -Depth 6
"var CALENDAR_DATA = $json;" | Set-Content -LiteralPath $jsFile -Encoding UTF8

Write-Host ""
Write-Host "calendario: $ok ok, $miss sem match  ->  $jsFile" -ForegroundColor Green
Write-Host "Abra calendario.html no navegador pra ver." -ForegroundColor Green
