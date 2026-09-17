<#
  posters-filmes.ps1 - baixa o POSTER oficial de cada filme (TMDB) e monta uma
  miniatura 16:9 (poster nitido no centro + fundo desfocado), salvando em
  <ThumbsDir>\<nome-do-arquivo-do-filme>.jpg  (substitui o frame do video).

  Precisa de uma API key gratuita do TMDB:
    themoviedb.org -> Login -> Settings -> API -> "Create" -> API Key (v3 auth)

  Uso:
    .\posters-filmes.ps1 -ApiKey SUA_CHAVE
    .\posters-filmes.ps1 -ApiKey SUA_CHAVE -Root "E:\AmorecoFlix\Filmes"
#>
param(
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [string]$Root      = 'E:\AmorecoFlix\Filmes',
    [string]$ThumbsDir = 'E:\AmorecoFlix\thumbs'
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
    $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($b) { $ffmpeg = $b.FullName }
}
if (-not $ffmpeg) { Write-Error "ffmpeg nao encontrado"; exit 1 }
New-Item -ItemType Directory -Force -Path $ThumbsDir | Out-Null

$exts = @('.mp4','.mkv','.avi','.mov','.m4v','.ts','.webm')
$vids = Get-ChildItem $Root -Recurse -File | Where-Object { $exts -contains $_.Extension.ToLower() }
Write-Host "$($vids.Count) filmes" -ForegroundColor Cyan

function Get-TitleYear($name) {
    $n = [IO.Path]::GetFileNameWithoutExtension($name)
    $year = $null
    if ($n -match '\((19|20)\d{2}\)') { $year = [int]($matches[0] -replace '[()]','') }
    $t = $n -replace '\((19|20)\d{2}\).*$','' -replace '\[[^\]]*\].*$',''
    $t = ($t -replace '\s*[-–:]\s*$','' -replace '\s{2,}',' ').Trim()
    return [pscustomobject]@{ Title = $t; Year = $year }
}

function Norm($s) {
    $s = "$s".ToLower()
    $s = $s -replace '(\d)\s*[ºª°]','$1' -replace '[ºª°]',''   # 3º -> 3
    $s = $s -replace '[:\-–—_.,]',' ' -replace '[^\p{Ll}\p{Nd} ]',''
    ($s -replace '\s+',' ').Trim()
}

# variacoes do titulo, da mais especifica p/ a mais ampla
function Get-Queries($title) {
    $q = New-Object System.Collections.Generic.List[string]
    $q.Add($title)                                            # completo
    $q.Add(($title -replace '\s+(\d+)\s*[-–:]\s*','$1 '))      # "Piratas 1 - Sub" -> "Piratas 1 Sub"
    $q.Add(($title -replace '\s+\d+\s*[-–:]\s*',' '))          # "Piratas 1 - Sub" -> "Piratas Sub"
    $q.Add(($title -replace '\s*[-–:].*$',''))                 # so a franquia
    $q | Where-Object { $_ -and $_.Trim().Length -ge 2 } | ForEach-Object { $_.Trim() } | Select-Object -Unique
}

function Score-Hit($hit, $year, $qNorm) {
    if (-not $hit.poster_path) { return -1000 }
    $s = [double]$hit.popularity
    $tn = Norm $hit.title;  $on = Norm $hit.original_title
    if ($tn -eq $qNorm -or $on -eq $qNorm) { $s += 5000 }
    elseif ($tn.StartsWith($qNorm) -or $qNorm.StartsWith($tn)) { $s += 800 }
    if ($year -and $hit.release_date -match '^(\d{4})') {
        $diff = [Math]::Abs([int]$matches[1] - $year)
        if     ($diff -eq 0) { $s += 2000 }
        elseif ($diff -le 1) { $s += 600 }
        elseif ($diff -le 2) { $s += 100 }
        else                 { $s -= 800 }
    }
    return $s
}

function Search-Poster($title, $year) {
    $best = $null; $bestScore = -1e9
    foreach ($cand in (Get-Queries $title)) {
        $qn = Norm $cand
        $url = "https://api.themoviedb.org/3/search/movie?api_key=$ApiKey&language=pt-BR&include_adult=false&query=" + [uri]::EscapeDataString($cand)
        try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 20 }
        catch { Start-Sleep -Milliseconds 500; continue }
        foreach ($h in ($r.results | Select-Object -First 6)) {
            $sc = Score-Hit $h $year $qn
            if ($sc -gt $bestScore) { $bestScore = $sc; $best = $h }
        }
        # achou titulo exato (e ano bate, se conhecido) -> encerra
        if ($best -and (Norm $best.title) -eq (Norm $title) -and
            (-not $year -or ($best.release_date -match "^$year"))) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($best -and $best.poster_path -and $bestScore -gt 0) { return $best }
    return $null
}

$ok = 0; $miss = 0
foreach ($v in $vids) {
    $out = Join-Path $ThumbsDir ($v.Name + '.jpg')
    $ty  = Get-TitleYear $v.Name
    $hit = Search-Poster $ty.Title $ty.Year
    if (-not $hit) {
        Write-Host ("  ? SEM MATCH: {0}" -f $v.Name) -ForegroundColor Yellow
        $miss++; continue
    }
    $posterUrl = "https://image.tmdb.org/t/p/w500$($hit.poster_path)"
    $tmp = Join-Path $env:TEMP ("poster_" + [guid]::NewGuid().ToString('N') + '.jpg')
    try { Invoke-WebRequest -Uri $posterUrl -OutFile $tmp -TimeoutSec 30 } catch { $miss++; continue }

    # 16:9 = poster nitido no centro sobre fundo desfocado do proprio poster
    $fc = '[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,boxblur=24:4,eq=brightness=-0.12[bg];' +
          '[0:v]scale=-1:480:force_original_aspect_ratio=decrease[fg];' +
          '[bg][fg]overlay=(W-w)/2:0'
    & $ffmpeg -y -i $tmp -filter_complex $fc -frames:v 1 -q:v 3 -- "$out" 2>$null
    Remove-Item $tmp -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $out) {
        $ok++
        Write-Host ("  OK  {0}  ->  {1} ({2})" -f $v.Name, $hit.title, $hit.release_date)
    } else { $miss++ }
    Start-Sleep -Milliseconds 200
}
Write-Host "posters: $ok ok, $miss sem match / falha" -ForegroundColor Green
