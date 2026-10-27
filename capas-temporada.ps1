<#
  capas-temporada.ps1 - thumb de cada PASTA DE TEMPORADA no estilo capa de DVD:
  poster da temporada (formato natural, retrato) + faixa preta no topo com
  "A Nª TEMPORADA". Sem recorte 16:9 nem fundo desfocado.

  Base: poster da temporada no TMDB (arte limpa, sem idioma); se nao houver,
  poster da serie. Sempre desenha a faixa por cima -> visual uniforme.
  Salva em <Root>\thumbs\<nome da pasta de temporada>.jpg  (o app le por esse nome).

  Uso local (HD plugado no PC):
    .\capas-temporada.ps1 -ApiKey SUA_CHAVE
    .\capas-temporada.ps1 -ApiKey ... -Only "The Vampire Diaries"   (uma serie)
    .\capas-temporada.ps1 -ApiKey ... -Force                        (refaz todas)

  Uso remoto (SEM plugar o HD - manda pela rede pro app na TV):
    .\capas-temporada.ps1 -ApiKey SUA_CHAVE -Remote
#>
param(
    [string]$ApiKey,
    [string]$Root = 'E:\AmorecoFlix',
    [string]$Only = '',
    [switch]$Force,
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

$ffmpeg = Find-FfTool 'ffmpeg'
if (-not $ffmpeg) { Write-Error 'ffmpeg nao encontrado'; exit 1 }

# o parser de filtro do ffmpeg no Windows nao aceita caminho com "C:\" nem
# fontconfig funciona -> copiamos a fonte p/ um dir sem dois-pontos e rodamos
# o ffmpeg a partir dele com caminho relativo.
$WORK = Join-Path $env:TEMP 'amoreco_capas'
New-Item -ItemType Directory -Force -Path $WORK | Out-Null
$srcFont = 'C:\Windows\Fonts\georgiab.ttf'
if (-not (Test-Path $srcFont)) { $srcFont = 'C:\Windows\Fonts\timesbd.ttf' }
Copy-Item $srcFont (Join-Path $WORK 'f.ttf') -Force

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

function Remote-Exists($destName) {
    $u = "$ApiUrl/api/list?path=thumbs"
    try { $entries = (Invoke-RestMethod $u -TimeoutSec 20).entries } catch { return $false }
    return [bool]($entries | Where-Object { -not $_.isDir -and $_.name -eq $destName })
}

function Send-ToTv($localFile, $destName) {
    $u = "$ApiUrl/api/upload?path=thumbs&name=" + [uri]::EscapeDataString($destName)
    try {
        $bytes = [IO.File]::ReadAllBytes($localFile)
        Invoke-RestMethod -Uri $u -Method Post -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 60 | Out-Null
        return $true
    } catch { Write-Host "    falha no upload p/ TV: $_" -ForegroundColor Red; return $false }
}

function Cover-Exists($destName) {
    if ($Remote) { return Remote-Exists $destName }
    return (Test-Path -LiteralPath (Join-Path $ThumbsDir $destName))
}

function Save-Cover($localTmpFile, $destName) {
    if ($Remote) { return Send-ToTv $localTmpFile $destName }
    $out = Join-Path $ThumbsDir $destName
    try { Copy-Item -LiteralPath $localTmpFile -Destination $out -Force } catch { return $false }
    return (Test-Path -LiteralPath $out)
}

# ids TMDB conhecidos (chave no formato Norm-Title do lib.ps1: minusculo, sem hifen).
# Evita erro de busca; nome nao listado cai na busca de TV do lib.ps1.
$KNOWN_IDS = @{
    'the vampire diaries'       = 18165
    'the originals'             = 46896
    'revenge'                   = 39358
    'lanternas'                 = 95350
    'lucky'                     = 278624
    'avatar a lenda de korra'   = 33880
    'a lenda de korra'          = 33880
    'fma brotherhood'           = 31911
    'death parade'              = 63333
    'percy jackson 2'           = 103540
    'percy jackson e os olimpianos' = 103540
}

$ORD = @('', 'PRIMEIRA','SEGUNDA','TERCEIRA','QUARTA','QUINTA','SEXTA','SETIMA','OITAVA','NONA','DECIMA',
         'DECIMA PRIMEIRA','DECIMA SEGUNDA','DECIMA TERCEIRA','DECIMA QUARTA','DECIMA QUINTA')
# com acento para o texto exibido
$ORD_ACC = @{ 'SETIMA' = 'S' + [char]0x00C9 + 'TIMA'; 'DECIMA' = 'D' + [char]0x00C9 + 'CIMA' }

function BannerText($n) {
    if ($n -ge 1 -and $n -lt $ORD.Count) {
        $w = $ORD[$n]
        foreach ($k in $ORD_ACC.Keys) { $w = $w -replace $k, $ORD_ACC[$k] }
        return "$w TEMPORADA"
    }
    return "$n" + [char]0x00AA + ' TEMPORADA'
}

function SeasonNum($name) {
    if ($name -match '(\d{1,2})\s*[' + [char]0x00AA + 'a]?\s*Temporada') { return [int]$matches[1] }
    if ($name -match '[Tt]emporada\s*(\d{1,2})')  { return [int]$matches[1] }
    if ($name -match '[sS](\d{1,2})(\D|$)')       { return [int]$matches[1] }
    if ($name -match '(?:Livro|Book|Parte|Part)\s*(\d{1,2})') { return [int]$matches[1] }
    return 0
}

function Get-TvId($showName) {
    $key = Norm-Title $showName
    if ($KNOWN_IDS.ContainsKey($key)) { return $KNOWN_IDS[$key] }
    $hit = Find-TmdbTv $showName
    if ($hit) { return [int]$hit.id }
    return 0
}

$posterCache = @{}
function Fetch-Poster($path) {
    if (-not $path) { return $null }
    if ($posterCache.ContainsKey($path)) { return $posterCache[$path] }
    $tmp = Join-Path $env:TEMP ('ct_' + [guid]::NewGuid().ToString('N') + '.jpg')
    if (-not (Save-TmdbImage $path 'w500' $tmp)) { return $null }
    $posterCache[$path] = $tmp
    return $tmp
}

# poster da temporada (arte limpa: sem language); fallback pt-BR; fallback serie
function Season-PosterPath($tvId, $season, $showPoster) {
    foreach ($lang in @('en-US', '', 'pt-BR')) {
        $s = Invoke-Tmdb "/tv/$tvId/season/$season" '' $lang
        if ($s.poster_path) { return $s.poster_path }
    }
    return $showPoster
}

# poster no formato natural (retrato, largura 500) + faixa preta com texto no
# topo - SEM recorte 16:9 nem fundo desfocado.
function Build-Thumb($srcJpg, $outJpg, $bannerText) {
    [IO.File]::WriteAllText((Join-Path $WORK 't.txt'), $bannerText, (New-Object Text.UTF8Encoding $false))
    $fc = "scale=500:-1[img];" +
          "[img]drawbox=x=0:y=0:w=500:h=54:color=black@0.62:t=fill[bar];" +
          "[bar]drawtext=fontfile=f.ttf:textfile=t.txt:fontcolor=white:fontsize=24:" +
          "x=(w-text_w)/2:y=(54-text_h)/2:shadowcolor=black@0.75:shadowx=1:shadowy=2"
    if (Test-Path -LiteralPath $outJpg) { [IO.File]::Delete($outJpg) }
    Push-Location $WORK
    & $ffmpeg -y -i "$srcJpg" -filter_complex $fc -frames:v 1 -q:v 3 "$outJpg" 2>$null
    $rc = $LASTEXITCODE
    Pop-Location
    return ($rc -eq 0 -and (Test-Path -LiteralPath $outJpg))
}

$ok = 0; $miss = 0
foreach ($cat in 'Series', 'Animes') {
    $shows = Get-Dirs $cat
    if (-not $shows) { continue }

    foreach ($showDir in $shows) {
        if ($Only -and $showDir.Name -notlike "*$Only*") { continue }
        $seasons = @(Get-Dirs $showDir.RelPath | Where-Object { (SeasonNum $_.Name) -gt 0 })
        if (-not $seasons) { continue }

        $tvId = Get-TvId $showDir.Name
        if (-not $tvId) { Write-Host "  ? sem TMDB id: $($showDir.Name)" -ForegroundColor Yellow; $miss += $seasons.Count; continue }
        $showPoster = (Invoke-Tmdb "/tv/$tvId").poster_path

        Write-Host "== $($showDir.Name)  (tv $tvId) ==" -ForegroundColor Cyan
        foreach ($seas in $seasons) {
            $n = SeasonNum $seas.Name
            $outName = $seas.Name + '.jpg'
            if ((Cover-Exists $outName) -and -not $Force) { Write-Host "  = $($seas.Name) (ja existe)"; continue }

            $pp  = Season-PosterPath $tvId $n $showPoster
            $src = Fetch-Poster $pp
            if (-not $src) { Write-Host "  ? sem poster: $($seas.Name)" -ForegroundColor Yellow; $miss++; continue }

            $txt = BannerText $n
            $tmpOut = Join-Path $env:TEMP ('ctout_' + [guid]::NewGuid().ToString('N') + '.jpg')
            if ((Build-Thumb $src $tmpOut $txt) -and (Save-Cover $tmpOut $outName)) {
                $ok++; Write-Host ("  OK  {0}  ->  {1}" -f $seas.Name, $txt)
            } else { $miss++; Write-Host "  FALHOU: $($seas.Name)" -ForegroundColor Red }
            if (Test-Path -LiteralPath $tmpOut) { Remove-Item -LiteralPath $tmpOut -Force -EA 0 }
            Start-Sleep -Milliseconds 150
        }
    }
}
$posterCache.Values | ForEach-Object { if (Test-Path $_) { [IO.File]::Delete($_) } }
Write-Host "`ncapas de temporada: $ok ok, $miss sem match" -ForegroundColor Green
