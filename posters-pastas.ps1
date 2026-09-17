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
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [string]$Root = 'E:\AmorecoFlix',
    [switch]$Remote,
    [string]$ApiUrl = 'http://localhost:8790'
)
$ErrorActionPreference = 'Continue'
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

# abreviacoes / correcoes de nome p/ busca
$ALIAS = @{
    'fma brotherhood'        = 'Fullmetal Alchemist Brotherhood'
    'fma'                    = 'Fullmetal Alchemist'
    'hxh'                    = 'Hunter x Hunter'
    'aot'                    = 'Attack on Titan'
    'snk'                    = 'Attack on Titan'
}
# folder de FRANQUIA em Filmes -> nome(s) da colecao no TMDB
$COLLECTION_ALIAS = @{
    'jurassic park'    = @('Jurassic World', 'Jurassic Park')
    'o bicho vai pegar'= @('Open Season', 'O Bicho Vai Pegar')
    'vingadores'       = @('Vingadores', 'The Avengers')
    'avatar'           = @('Avatar')
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
    return [double]$common / $nw.Count      # fracao das palavras do resultado presentes na busca
}

function Get-ShowPoster($folderName) {
    $base = ($folderName -replace '\s*[-–]\s*\d+\s*(a|ª)?\s*Temporada\s*$','' `
                         -replace '\s*\d+\s*(a|ª)?\s*Temporada\s*$','').Trim()
    $key  = Norm $base
    $queries = @()
    if ($ALIAS.ContainsKey($key)) { $queries += $ALIAS[$key] }
    $queries += $base
    $queries += ($base -replace '\s+\d+\s*$','')            # sem numero final
    $queries = $queries | Where-Object { $_ -and $_.Trim().Length -ge 2 } | Select-Object -Unique

    $best = $null; $bestScore = -1e9
    foreach ($q in $queries) {
        $qn = Norm $q
        $url = "https://api.themoviedb.org/3/search/tv?api_key=$ApiKey&language=pt-BR&query=" + [uri]::EscapeDataString($q)
        try { $r = Invoke-RestMethod $url -TimeoutSec 20 } catch { continue }
        foreach ($h in ($r.results | Select-Object -First 6)) {
            if (-not $h.poster_path) { continue }
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

$PosterCache = @{}
function Fetch-Poster($posterPath) {
    if ($PosterCache.ContainsKey($posterPath)) { return $PosterCache[$posterPath] }
    $tmp = Join-Path $env:TEMP ("pp_" + [guid]::NewGuid().ToString('N') + '.jpg')
    $got = $false
    foreach ($n in 1..3) {
        try { Invoke-WebRequest "https://image.tmdb.org/t/p/w500$posterPath" -OutFile $tmp -TimeoutSec 40; $got = $true; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if (-not $got) { return $null }
    $PosterCache[$posterPath] = $tmp
    return $tmp
}

# tira palavras de "colecao" p/ comparar so o nome da franquia
function NormColl($s) {
    (Norm $s) -replace '\b(colecao|collection|saga|trilogia|duologia|pentalogia|filmes|the movies?)\b','' -replace '\s+',' '
}

function Search-Kind($kind, $q) {
    $url = "https://api.themoviedb.org/3/search/$kind`?api_key=$ApiKey&language=pt-BR&query=" + [uri]::EscapeDataString($q)
    try { return (Invoke-RestMethod $url -TimeoutSec 20).results } catch { return @() }
}

# capa da COLECAO/franquia (Filmes) - colecao primeiro, senao o 1o filme
function Get-CollectionPoster($folderName) {
    $key = Norm $folderName
    $names = @($folderName)
    if ($COLLECTION_ALIAS.ContainsKey($key)) { $names = $COLLECTION_ALIAS[$key] }

    # 1) COLECOES
    $best = $null; $bestOv = 0
    foreach ($q in $names) {
        $qn = Norm $q
        foreach ($h in (Search-Kind 'collection' $q | Select-Object -First 8)) {
            if (-not $h.poster_path) { continue }
            $ov = [Math]::Max((WordOverlap $qn (NormColl $h.name)),
                              (WordOverlap $qn (NormColl $h.original_name)))
            if ($ov -gt $bestOv) { $bestOv = $ov; $best = $h }
        }
        Start-Sleep -Milliseconds 150
        if ($bestOv -ge 0.85) { break }
    }
    if ($best -and $bestOv -ge 0.5) { return $best }

    # 2) fallback: 1o filme da franquia
    $best = $null; $bestOv = 0
    foreach ($q in $names) {
        $qn = Norm $q
        foreach ($h in (Search-Kind 'movie' $q | Select-Object -First 6)) {
            if (-not $h.poster_path) { continue }
            $ov = [Math]::Max((WordOverlap $qn (Norm $h.title)), (WordOverlap $qn (Norm $h.original_title)))
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
