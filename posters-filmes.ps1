<#
  posters-filmes.ps1 - miniatura 16:9 de cada filme em
  <ThumbsDir>\<nome-do-arquivo-do-filme>.jpg  (substitui o frame do video):
  filme de colecao (numa pasta dentro de Filmes) ganha a arte 16:9 do TMDB com o
  nome do filme escrito (pt, senao en); filme solto - ou sem essa arte - fica com o
  poster nitido no centro + fundo desfocado do proprio poster.

  Precisa de uma API key gratuita do TMDB:
    themoviedb.org -> Login -> Settings -> API -> "Create" -> API Key (v3 auth)

  Uso:
    .\posters-filmes.ps1 -ApiKey SUA_CHAVE
    .\posters-filmes.ps1 -ApiKey SUA_CHAVE -Root "E:\AmorecoFlix\Filmes"
#>
param(
    [string]$ApiKey,
    [string]$Root      = 'E:\AmorecoFlix\Filmes',
    [string]$ThumbsDir = 'E:\AmorecoFlix\thumbs'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ffmpeg = Find-FfTool 'ffmpeg'
if (-not $ffmpeg) { Write-Error "ffmpeg nao encontrado"; exit 1 }
New-Item -ItemType Directory -Force -Path $ThumbsDir | Out-Null

$exts = @('.mp4','.mkv','.avi','.mov','.m4v','.ts','.webm')
$vids = Get-ChildItem $Root -Recurse -File | Where-Object { $exts -contains $_.Extension.ToLower() }
Write-Host "$($vids.Count) filmes" -ForegroundColor Cyan

$ok = 0; $miss = 0
foreach ($v in $vids) {
    $out = Join-Path $ThumbsDir ($v.Name + '.jpg')
    $hit = Find-TmdbMovie $v.Name -NeedPoster      # titulo + ano do nome do arquivo (lib.ps1)
    if (-not $hit) {
        Write-Host ("  ? SEM MATCH: {0}" -f $v.Name) -ForegroundColor Yellow
        $miss++; continue
    }
    $tmp = Join-Path $env:TEMP ("poster_" + [guid]::NewGuid().ToString('N') + '.jpg')
    $bd = $null
    if ($v.DirectoryName.TrimEnd('\') -ine (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')) { $bd = Get-TmdbTitleBackdrop $hit.id }   # so colecao
    if ($bd -and (Save-TmdbImage $bd 'w780' $tmp)) {
        # arte 16:9 com o titulo: so ajusta para 854x480
        $kind = 'arte 16:9'
        & $ffmpeg -y -i $tmp -vf 'scale=854:480:force_original_aspect_ratio=increase,crop=854:480' -frames:v 1 -q:v 3 -- "$out" 2>$null
    } elseif (Save-TmdbImage $hit.poster_path 'w500' $tmp) {
        # sem arte 16:9: poster nitido no centro sobre fundo desfocado do proprio poster
        $kind = 'poster + fundo desfocado'
        $fc = '[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,boxblur=24:4,eq=brightness=-0.12[bg];' +
              '[0:v]scale=-1:480:force_original_aspect_ratio=decrease[fg];' +
              '[bg][fg]overlay=(W-w)/2:0'
        & $ffmpeg -y -i $tmp -filter_complex $fc -frames:v 1 -q:v 3 -- "$out" 2>$null
    } else { $miss++; continue }
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $out) {
        $ok++
        Write-Host ("  OK  {0}  ->  {1} ({2}) [{3}]" -f $v.Name, $hit.title, $hit.release_date, $kind)
    } else { $miss++ }
    Start-Sleep -Milliseconds 200
}
Write-Host "posters: $ok ok, $miss sem match / falha" -ForegroundColor Green
