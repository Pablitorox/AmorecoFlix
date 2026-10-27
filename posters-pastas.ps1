<#
  posters-pastas.ps1 - capa em CADA pasta de show/franquia.

  - <Root>\Series\*  e  <Root>\Animes\*  -> poster da serie/anime (busca TV)
    + as subpastas de temporada herdam a mesma capa
  - <Root>\Filmes\*  (pastas de sequencia) -> poster da COLECAO/franquia

  Salva o POSTER LIMPO (sem recorte 16:9 nem fundo desfocado) em
  <Root>\thumbs\<nome da pasta>.jpg. O app AmorecoFlix acompanha o formato
  natural da capa quando ela nao e 16:9 (nao precisa mais do blur).

  Uso local (HD plugado no PC):
    .\posters-pastas.ps1 -ApiKey SUA_CHAVE

  Uso remoto (SEM plugar o HD - manda pela rede pro app na TV, que precisa
  estar ligado e conectado ao servidor local em AmorecoFlix-Enviar-Arquivo):
    .\posters-pastas.ps1 -ApiKey SUA_CHAVE -Remote
#>
param(
    [string]$ApiKey,
    [string]$Root = 'E:\AmorecoFlix',
    [switch]$Remote,
    [string]$ApiUrl = 'http://localhost:8790'
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Remote) {
    $ThumbsDir = Join-Path $Root 'thumbs'
    New-Item -ItemType Directory -Force -Path $ThumbsDir | Out-Null
}

# ---------------- acesso a arvore de pastas: local (HD) ou remoto (rede) ----------------
function Get-Dirs($relPath) {
    if ($Remote) {
        $u = "$ApiUrl/api/list?path=" + [uri]::EscapeDataString($relPath)
        try { $entries = (Invoke-RestMethod $u -TimeoutSec 20).entries } catch { return @() }
        return @($entries | Where-Object { $_.isDir } | ForEach-Object {
            [pscustomobject]@{ Name = $_.name; RelPath = if ($relPath) { "$relPath/$($_.name)" } else { $_.name } }
        })
    } else {
        $local = Join-Path $Root ($relPath -replace '/', '\')
        if (-not (Test-Path -LiteralPath $local)) { return @() }
        return @(Get-ChildItem -LiteralPath $local -Directory | ForEach-Object {
            [pscustomobject]@{ Name = $_.Name; RelPath = if ($relPath) { "$relPath/$($_.Name)" } else { $_.Name } }
        })
    }
}

function Send-ToTv($localFile, $destName) {
    $u = "$ApiUrl/api/upload?path=thumbs&name=" + [uri]::EscapeDataString($destName)
    try {
        $bytes = [IO.File]::ReadAllBytes($localFile)
        Invoke-RestMethod -Uri $u -Method Post -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 60 | Out-Null
        return $true
    } catch { Write-Host "    falha no upload p/ TV: $_" -ForegroundColor Red; return $false }
}

# coloca o arquivo baixado (temp) no destino final: local (thumbs/) ou via rede
function Save-Cover($localTmpFile, $destName) {
    if ($Remote) { return Send-ToTv $localTmpFile $destName }
    $out = Join-Path $ThumbsDir $destName
    try { Copy-Item -LiteralPath $localTmpFile -Destination $out -Force } catch { return $false }
    return (Test-Path -LiteralPath $out)
}

# capa da serie/anime: busca de TV do lib.ps1 (apelidos de pasta em $TmdbAlias)
function Get-ShowPoster($folderName) { Find-TmdbTv $folderName -NeedPoster }

$PosterCache = @{}
function Fetch-Poster($posterPath) {
    if ($PosterCache.ContainsKey($posterPath)) { return $PosterCache[$posterPath] }
    $tmp = Join-Path $env:TEMP ("pp_" + [guid]::NewGuid().ToString('N') + '.jpg')
    if (-not (Save-TmdbImage $posterPath 'w500' $tmp)) { return $null }
    $PosterCache[$posterPath] = $tmp
    return $tmp
}

# capa da COLECAO/franquia (Filmes) - colecao primeiro, senao o 1o filme
function Get-CollectionPoster($folderName) {
    # 1) COLECOES (apelidos de pasta em $TmdbCollectionAlias)
    $hit = Find-TmdbCollection $folderName -NeedPoster
    if ($hit) { return $hit }

    # 2) fallback: 1o filme da franquia
    $key = Norm-Title $folderName
    $names = @($folderName)
    if ($script:TmdbCollectionAlias.ContainsKey($key)) { $names = $script:TmdbCollectionAlias[$key] }
    $best = $null; $bestOv = 0
    foreach ($q in $names) {
        $qn = Norm-Title $q
        $r = Invoke-Tmdb '/search/movie' ('&query=' + [uri]::EscapeDataString($q))
        foreach ($h in ($r.results | Select-Object -First 6)) {
            if (-not $h.poster_path) { continue }
            $ov = [Math]::Max((Get-WordOverlap $qn (Norm-Title $h.title)), (Get-WordOverlap $qn (Norm-Title $h.original_title)))
            if ($ov -gt $bestOv) { $bestOv = $ov; $best = $h }
        }
        Start-Sleep -Milliseconds 150
        if ($bestOv -ge 0.85) { break }
    }
    if ($best -and $bestOv -ge 0.34) { return $best }
    return $null
}

$ok = 0; $miss = 0

# ---- FRANQUIAS em Filmes ----
Write-Host "== Filmes (franquias) ==" -ForegroundColor Cyan
foreach ($fdir in (Get-Dirs 'Filmes')) {
    $hit = Get-CollectionPoster $fdir.Name
    if (-not $hit) { Write-Host "  ? $($fdir.Name)" -ForegroundColor Yellow; $miss++; continue }
    $hn = $hit.name; if (-not $hn) { $hn = $hit.title }
    $tmp = Fetch-Poster $hit.poster_path
    if ($tmp -and (Save-Cover $tmp ($fdir.Name + '.jpg'))) {
        $ok++; Write-Host ("  OK  {0}  ->  {1}" -f $fdir.Name, $hn)
    } else { $miss++ }
    Start-Sleep -Milliseconds 200
}

foreach ($cat in 'Series','Animes') {
    Write-Host "== $cat ==" -ForegroundColor Cyan
    foreach ($showDir in (Get-Dirs $cat)) {
        $hit = Get-ShowPoster $showDir.Name
        if (-not $hit) { Write-Host "  ? $($showDir.Name)" -ForegroundColor Yellow; $miss++; continue }
        $hitName = $hit.name; if (-not $hitName) { $hitName = $hit.title }
        $tmp = Fetch-Poster $hit.poster_path
        if ($tmp -and (Save-Cover $tmp ($showDir.Name + '.jpg'))) {
            $ok++
            Write-Host ("  OK  {0}  ->  {1}" -f $showDir.Name, $hitName)
        } else { $miss++ }

        # subpastas de temporada -> mesma capa da serie
        foreach ($seas in (Get-Dirs $showDir.RelPath)) {
            if ($tmp -and (Save-Cover $tmp ($seas.Name + '.jpg'))) {
                $ok++; Write-Host ("      + {0}" -f $seas.Name)
            }
        }
        Start-Sleep -Milliseconds 200
    }
}
Write-Host "capas de pasta: $ok ok, $miss sem match" -ForegroundColor Green
