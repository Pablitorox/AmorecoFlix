<#
  gerar-thumbnails.ps1 - cria as miniaturas da biblioteca numa pasta central.

  Para cada video em <Root> (recursivo), extrai 1 frame com ffmpeg e salva em
  <Root>\thumbs\<nome-completo-do-video>.jpg
  (ex.: "Death Parade Ep 01.mkv"  ->  thumbs\Death Parade Ep 01.mkv.jpg)

  O app AmorecoFlix procura a capa nessa pasta pelo nome do arquivo de video.

  Uso:
    .\gerar-thumbnails.ps1                 # E:\AmorecoFlix
    .\gerar-thumbnails.ps1 -Root D:\Midia
    .\gerar-thumbnails.ps1 -Force          # refaz as que ja existem

  Requer ffmpeg  (winget install Gyan.FFmpeg).
#>
param(
    [string]$Root = 'E:\AmorecoFlix',
    [switch]$Force
)

$ErrorActionPreference = 'Continue'
$exts = @('.mp4','.mkv','.avi','.mov','.m4v','.ts','.webm','.wmv','.flv','.mpg','.mpeg','.m2ts','.3gp')

$ffmpeg  = (Get-Command ffmpeg  -ErrorAction SilentlyContinue).Source
$ffprobe = (Get-Command ffprobe -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
    $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($b) { $ffmpeg = $b.FullName; $ffprobe = Join-Path $b.Directory 'ffprobe.exe' }
}
if (-not $ffmpeg) { Write-Error "ffmpeg nao encontrado. Rode: winget install Gyan.FFmpeg"; exit 1 }
if (-not (Test-Path $Root)) { Write-Error "pasta nao existe: $Root"; exit 1 }

$thumbs = Join-Path $Root 'thumbs'
New-Item -ItemType Directory -Force -Path $thumbs | Out-Null

$vids = Get-ChildItem $Root -Recurse -File |
        Where-Object { $exts -contains $_.Extension.ToLower() -and $_.DirectoryName -ne $thumbs }
Write-Host "$($vids.Count) videos em $Root" -ForegroundColor Cyan
$done = 0; $skip = 0; $fail = 0

foreach ($v in $vids) {
    $jpg = Join-Path $thumbs ($v.Name + '.jpg')          # nome COMPLETO do video + .jpg
    if ((Test-Path -LiteralPath $jpg) -and -not $Force) { $skip++; continue }

    $dur = 0.0
    try {
        $d = & $ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$($v.FullName)" 2>$null
        if ($d) { [double]::TryParse(($d -replace ',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$dur) | Out-Null }
    } catch {}
    if ($dur -le 0) { $dur = 600 }
    $ss = [Math]::Max(30, [Math]::Min($dur * 0.15, 420))

    & $ffmpeg -y -ss $ss -i "$($v.FullName)" -frames:v 1 -vf "scale=480:-2" -q:v 3 -- "$jpg" 2>$null
    if (-not (Test-Path -LiteralPath $jpg)) {
        & $ffmpeg -y -ss 5 -i "$($v.FullName)" -frames:v 1 -vf "scale=480:-2" -q:v 3 -- "$jpg" 2>$null
    }
    if (Test-Path -LiteralPath $jpg) {
        $done++
        Write-Host ("  [{0}/{1}] {2}" -f ($done + $skip), $vids.Count, $v.Name)
    } else {
        $fail++
        Write-Host ("  FALHA (corrompido?): {0}" -f $v.Name) -ForegroundColor Yellow
    }
}
Write-Host "OK: $done geradas, $skip ja existiam, $fail falhas  ->  $thumbs" -ForegroundColor Green
