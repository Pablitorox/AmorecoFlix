<#
  import-serie.ps1 - importa uma pasta de temporada baixada para a biblioteca.

  COPIA (nao move) cada episodio - assim funciona mesmo com o torrent ainda
  aberto/seedando no BitTorrent Web. A origem em Downloads fica intacta;
  remova os torrents quando quiser (ou rode  .\limpar-downloads.ps1).

  - detecta a temporada (nome da pasta ou dos arquivos)
  - E:\AmorecoFlix\Series\<Show>\<Show> - Na Temporada\<Show> SxxEyy.<ext>
  - leva legendas (.srt/.ass) de mesmo nome
  - baixa o still oficial de cada episodio (TMDB) + capa da serie/temporada

  Uso:
    .\import-serie.ps1 -Src "<pasta baixada>" -Show "The Vampire Diaries" -TvId 18165 -ApiKey <chave>
    (opcional: -Season 4 ; -WhatIf)
#>
param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Show,
    [Parameter(Mandatory=$true)][int]$TvId,
    [string]$ApiKey,
    [int]$Season = 0,
    [string]$Root = 'E:\AmorecoFlix',
    [switch]$WhatIf
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ORD = [char]0x00AA          # 'a' ordinal feminino, sem problema de encoding
$ThumbsDir = Join-Path $Root 'thumbs'
$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$sext = @('.srt','.ass','.ssa','.sub','.idx','.vtt')

$ffmpeg  = Find-FfTool 'ffmpeg'
$ffprobe = Find-FfTool 'ffprobe'
$compatLib = Join-Path $PSScriptRoot 'checar-compatibilidade.ps1'
if (Test-Path -LiteralPath $compatLib) { . $compatLib -AsLibrary }
if (-not (Test-Path -LiteralPath $Src)) { Write-Error "pasta nao existe: $Src"; exit 1 }

if ($Season -le 0 -and $Src -match '(\d{1,2})\s*[' + $ORD + 'a]?\s*Temporada') { $Season = [int]$matches[1] }
if ($Season -le 0 -and (Split-Path $Src -Leaf) -match '[sS](\d{1,2})') { $Season = [int]$matches[1] }

$vids = Get-ChildItem -LiteralPath $Src -Recurse -File | Where-Object { $vext -contains $_.Extension.ToLower() }
if (-not $vids) { Write-Error "nenhum video em $Src"; exit 1 }
if ($Season -le 0 -and $vids[0].Name -match '[sS](\d{1,2})[\s._\-]*[eE]\d') { $Season = [int]$matches[1] }
if ($Season -le 0 -and $vids[0].Name -match '(\d{1,2})[xX]\d{1,3}') { $Season = [int]$matches[1] }
if ($Season -le 0) { Write-Error "temporada nao detectada - use -Season N"; exit 1 }

$seasonFolder = "$Show - $Season$ORD Temporada"
$destDir = Join-Path (Join-Path (Join-Path $Root 'Series') $Show) $seasonFolder
Write-Host "== $Show  -  Temporada $Season  ->  $destDir ==" -ForegroundColor Cyan
if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }

function Get-Ep($name) {
    if ($name -match '[sS]\d{1,2}[\s._\-]*[eE](\d{1,3})') { return [int]$matches[1] }
    if ($name -match '\d{1,2}[xX](\d{1,3})') { return [int]$matches[1] }
    if ($name -match '^\s*(\d{1,3})\s*[-.\s]') { return [int]$matches[1] }
    return 0
}
function Copy-Verify($src, $dst) {
    if ((Test-Path -LiteralPath $dst) -and (Get-Item -LiteralPath $dst).Length -eq (Get-Item -LiteralPath $src).Length) {
        # so aceita "ja copiado" por tamanho se o destino tambem passar na
        # checagem basica - senao um re-download do MESMO tamanho (mesmo
        # release, ex: pack de novo do mesmo torrent) nunca substituiria um
        # arquivo ja corrompido (moov ausente etc) que so tem o tamanho igual
        # por coincidencia de encode, nao por ser o mesmo conteudo intacto.
        if (Get-Command Get-CompatIssues -EA 0) {
            $destIssues = Get-CompatIssues -File $dst -Ffprobe $ffprobe -Ffmpeg $ffmpeg -SkipIntegrity
            if (-not $destIssues) { return $true }
            Write-Host "    destino ja existe com o mesmo tamanho mas esta com problema ($($destIssues -join '; ')) - recopiando" -ForegroundColor Yellow
        } else {
            return $true
        }
    }
    try {
        $in  = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
        $out = [IO.File]::Create($dst)
        $in.CopyTo($out, 1MB); $out.Flush(); $out.Close(); $in.Close()
    } catch { Write-Host "    COPIA FALHOU: $_" -ForegroundColor Red; return $false }
    return ((Get-Item -LiteralPath $dst).Length -eq (Get-Item -LiteralPath $src).Length)
}

$imported = @()
foreach ($v in ($vids | Sort-Object Name)) {
    $ep = Get-Ep $v.BaseName
    if ($ep -le 0) { Write-Host "  ? sem numero: $($v.Name)" -ForegroundColor Yellow; continue }
    $newBase = ('{0} S{1:D2}E{2:D2}' -f $Show, $Season, $ep)
    $dest = Join-Path $destDir ($newBase + $v.Extension)
    Write-Host ("  E{0:D2}  {1}" -f $ep, $v.Name)
    if ($WhatIf) { $imported += [pscustomobject]@{ Ep=$ep; NewName=($newBase+$v.Extension) }; continue }

    # origem com problema grave (corrompida/truncada) NAO pode sobrescrever
    # um destino existente - preserva a copia atual, so avisa.
    if ((Test-Path -LiteralPath $dest) -and (Get-Command Get-CompatIssues -EA 0)) {
        $srcIssues = @(Get-CompatIssues -File $v.FullName -Ffprobe $ffprobe -Ffmpeg $ffmpeg -SkipIntegrity) | Where-Object { $_ -match 'CORROMPIDO|TRUNCADO|sem faixa' }
        if ($srcIssues) {
            Write-Host ("    ORIGEM COM PROBLEMA ({0}) - mantendo o arquivo atual na biblioteca, NAO sobrescrevi" -f ($srcIssues -join '; ')) -ForegroundColor Red
            $imported += [pscustomobject]@{ Ep=$ep; NewName=($newBase+$v.Extension) }
            continue
        }
    }

    if (Copy-Verify $v.FullName $dest) {
        if (Get-Command Get-CompatIssues -EA 0) {
            $issues = Get-CompatIssues -File $dest -Ffprobe $ffprobe -Ffmpeg $ffmpeg
            foreach ($i in $issues) { Write-Host "    AVISO compatibilidade: $i" -ForegroundColor Yellow }
        }
        $subsDir = Join-Path $Root 'subs'
        New-Item -ItemType Directory -Force -Path $subsDir | Out-Null
        Get-ChildItem -LiteralPath $v.DirectoryName -File | Where-Object {
            $sext -contains $_.Extension.ToLower() -and $_.BaseName -like ($v.BaseName + '*') -and $_.Length -ge 200
        } | ForEach-Object {
            $suf = $_.BaseName.Substring([Math]::Min($v.BaseName.Length, $_.BaseName.Length))
            # pasta central /subs, casada pelo nome COMPLETO do video importado
            Copy-Verify $_.FullName (Join-Path $subsDir ($newBase + $v.Extension + $suf + $_.Extension)) | Out-Null
        }
        $imported += [pscustomobject]@{ Ep=$ep; NewName=($newBase+$v.Extension) }
    }
}
Write-Host ("  copiados: {0}/{1}" -f $imported.Count, $vids.Count)
if ($WhatIf) { exit 0 }

# stills dos episodios importados
$sea = $null
try { $sea = Invoke-RestMethod "https://api.themoviedb.org/3/tv/$TvId/season/$Season`?api_key=$ApiKey&language=pt-BR" -TimeoutSec 25 } catch {}
foreach ($it in $imported) {
    $out = Join-Path $ThumbsDir ($it.NewName + '.jpg')
    if (Test-Path -LiteralPath $out) { continue }
    $epd = $null; if ($sea) { $epd = $sea.episodes | Where-Object { $_.episode_number -eq $it.Ep } | Select-Object -First 1 }
    if (-not ($epd -and $epd.still_path)) { Write-Host "  E$($it.Ep) sem still" -ForegroundColor Yellow; continue }
    $tmp = Join-Path $env:TEMP ("st_" + [guid]::NewGuid().ToString('N') + '.jpg')
    try {
        Invoke-WebRequest "https://image.tmdb.org/t/p/w780$($epd.still_path)" -OutFile $tmp -TimeoutSec 30
        & $ffmpeg -y -i $tmp -vf "scale=854:480:force_original_aspect_ratio=increase,crop=854:480" -frames:v 1 -q:v 3 -- "$out" 2>$null
        Write-Host ("  still E{0:D2}  '{1}'" -f $it.Ep, $epd.name)
    } catch {}
    if (Test-Path $tmp) { [IO.File]::Delete($tmp) }
    Start-Sleep -Milliseconds 150
}

# capa da serie (limpa)
try {
    $tv = Invoke-RestMethod "https://api.themoviedb.org/3/tv/$TvId`?api_key=$ApiKey&language=pt-BR" -TimeoutSec 20
    $fcPlain = '[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,boxblur=24:4,eq=brightness=-0.14[bg];[0:v]scale=-1:480[fg];[bg][fg]overlay=(W-w)/2:0'
    $tmp = Join-Path $env:TEMP ("pp_" + [guid]::NewGuid().ToString('N') + '.jpg')
    Invoke-WebRequest "https://image.tmdb.org/t/p/w500$($tv.poster_path)" -OutFile $tmp -TimeoutSec 30
    & $ffmpeg -y -i $tmp -filter_complex $fcPlain -frames:v 1 -q:v 3 -- (Join-Path $ThumbsDir "$Show.jpg") 2>$null
    [IO.File]::Delete($tmp)
    Write-Host "  capa da serie OK"
} catch { Write-Host "  capa da serie falhou: $_" -ForegroundColor Yellow }

# capa da temporada com faixa "A Nª TEMPORADA" (mesma logica p/ todas as series)
$capas = Join-Path $PSScriptRoot 'capas-temporada.ps1'
if (Test-Path $capas) {
    & $capas -ApiKey $ApiKey -Root $Root -Only $Show
} else {
    Write-Host "  capas-temporada.ps1 nao encontrado - rode manualmente" -ForegroundColor Yellow
}

# sinopse, titulos dos episodios e fundo 16:9 para o app (meta\biblioteca.json)
$metaPs = Join-Path $PSScriptRoot 'metadados.ps1'
if (Test-Path $metaPs) { & $metaPs -ApiKey $ApiKey -Root $Root -Only $Show }

Write-Host ("PRONTO: {0} eps de {1} T{2}" -f $imported.Count, $Show, $Season) -ForegroundColor Green
