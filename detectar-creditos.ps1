<#
  detectar-creditos.ps1 - descobre em que segundo COMECAM os creditos finais de
  cada episodio, analisando o proprio video (ffmpeg), e grava em skip.json.

  Como funciona:
    1. Decodifica so o final do episodio (ultimos ~8 min) a 1 quadro/s e mede,
       por quadro, a % de pixels escuros (filtro blackframe).
    2. Creditos = fundo escuro (>= 88%) com texto: a % oscila (nunca fica 100%
       cravado como um fade puro). Procura o ULTIMO trecho continuo assim,
       com pelo menos 15 s (mediana >= 93% escuro), tolerando pequenas quebras.
    3. Aceita cena pos-creditos (o trecho pode terminar ate 4 min antes do fim).
    4. Grava  "<arquivo>": { "cr": [inicioSeg, duracaoSeg] }  no skip.json,
       preservando op/ed do skip-anime.ps1.

  O app mostra o card "Proximo episodio" quando o tempo passa de cr[0].
  Sem cr (creditos sobre imagem, etc.) o app usa um valor padrao (fim - 45 s).

  Uso:
    .\detectar-creditos.ps1                          # toda a biblioteca (pula ja analisados)
    .\detectar-creditos.ps1 -Only "The Originals"    # so uma serie (nome da pasta)
    .\detectar-creditos.ps1 -Path C:\x\ep.mkv -Show  # 1 arquivo, imprime o resultado, nao grava
    .\detectar-creditos.ps1 -Force                   # reanalisa tudo
#>
param(
    [string]$Root = 'E:\AmorecoFlix',
    [string]$Only = '',
    [string]$Path = '',
    [switch]$Force,
    [switch]$Show,
    [int]$WindowMax = 480,      # segundos analisados no fim do episodio
    [double]$DarkPct = 88,      # % minima de pixels escuros p/ contar como "credito"
    [double]$MinLen = 15,       # duracao minima do trecho de creditos (s)
    [double]$MedianMin = 93,    # mediana minima de escuridao no trecho (cenas escuras ficam ~50-75)
    [double]$MaxGap = 4,        # quebra tolerada dentro do trecho (s)
    [double]$MaxTail = 240      # o trecho pode acabar ate N s antes do fim (cena pos-creditos)
)
$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'lib.ps1')
$ffmpeg  = Find-FfTool 'ffmpeg'
$ffprobe = Find-FfTool 'ffprobe'
if (-not $ffmpeg -or -not $ffprobe) { Write-Error 'ffmpeg/ffprobe nao encontrados'; exit 1 }

function Get-Duration($file) {
    try { return [double](& $ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$file" 2>$null) } catch { return 0 }
}

# Retorna @{ start=..; dur=..; note=.. } ; start = $null quando nao achou.
function Find-Credits($file) {
    $dur = Get-Duration $file
    if ($dur -lt 300) { return @{ start = $null; dur = $dur; note = 'curto demais' } }
    $win   = [math]::Min($WindowMax, $dur * 0.4)
    $begin = [math]::Floor($dur - $win)

    $errFile = [IO.Path]::GetTempFileName()
    try {
        $ffArgs = @('-hide_banner','-nostats','-ss',"$begin",'-i',$file,'-an','-sn','-dn',
                  '-vf','fps=1,scale=192:-2,blackframe=amount=0:threshold=32','-f','null','-')
        $p = Start-Process -FilePath $ffmpeg -ArgumentList ($ffArgs | ForEach-Object { '"' + $_ + '"' }) `
             -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile -RedirectStandardOutput ([IO.Path]::GetTempFileName())
        $frames = New-Object System.Collections.ArrayList
        foreach ($ln in [IO.File]::ReadLines($errFile)) {
            if ($ln -match 'blackframe.*pblack:(\d+).*\bt:(-?[\d.]+)') {
                $tt = [double]$matches[2] + $begin
                [void]$frames.Add(@($tt, [int]$matches[1]))
            }
        }
    } finally { Remove-Item $errFile -EA 0 }

    if ($frames.Count -lt 30) { return @{ start = $null; dur = $dur; note = "poucos quadros ($($frames.Count))" } }

    # monta trechos "creditos" (escuro), fundindo quebras <= MaxGap
    # cada trecho: @(inicio, fim, lista de pblack)
    $runs = @(); $rs = $null; $re = $null; $vals = $null
    foreach ($f in $frames) {
        $t = $f[0]
        if ($f[1] -ge $DarkPct) {
            if ($rs -ne $null -and ($t - $re) -le ($MaxGap + 1.01)) {
                $re = $t; [void]$vals.Add($f[1])
            } else {
                if ($rs -ne $null) { $runs += ,@($rs, $re, $vals) }
                $rs = $t; $re = $t; $vals = New-Object System.Collections.ArrayList; [void]$vals.Add($f[1])
            }
        }
    }
    if ($rs -ne $null) { $runs += ,@($rs, $re, $vals) }

    # ultimo trecho valido: longo, escuro de verdade (mediana), com texto (nao so
    # preto puro) e perto do fim. Trechos curtos (< 30 s) tem que colar no fim.
    for ($i = $runs.Count - 1; $i -ge 0; $i--) {
        $r = $runs[$i]
        $len = $r[1] - $r[0] + 1
        if ($len -lt $MinLen) { continue }
        if ($r[1] -lt ($dur - $MaxTail)) { continue }
        if ($len -lt 30 -and $r[1] -lt ($dur - 90)) { continue }
        $sorted = @($r[2] | Sort-Object)
        $median = $sorted[[int][math]::Floor($sorted.Count / 2)]
        if ($median -lt $MedianMin) { continue }
        $text = @($r[2] | Where-Object { $_ -lt 100 }).Count
        if (($text / [math]::Max(1, $r[2].Count)) -lt 0.5) { continue }
        return @{ start = [math]::Round($r[0], 1); dur = $dur; note = ('trecho {0:N0}s ate {1:N0}s, mediana {2}%' -f $r[0], $r[1], $median) }
    }
    return @{ start = $null; dur = $dur; note = 'sem trecho de creditos escuro' }
}

# ---- modo arquivo unico ----
if ($Path) {
    $r = Find-Credits $Path
    if ($r.start -ne $null) { Write-Host ("creditos em {0:N1}s de {1:N0}s ({2})" -f $r.start, $r.dur, $r.note) -ForegroundColor Green }
    else { Write-Host ("nao detectado: {0}" -f $r.note) -ForegroundColor Yellow }
    if ($Show) { return }
    $files = @(Get-Item -LiteralPath $Path)
} else {
    $lib = Join-Path $Root 'Series'
    if ($Only) { $lib = Join-Path $lib $Only }
    $vext = @('.mkv','.mp4','.avi','.m4v')
    $files = @(Get-ChildItem -LiteralPath $lib -Recurse -File -EA 0 | Where-Object { $vext -contains $_.Extension.ToLower() } | Sort-Object FullName)
}

$skipFile  = Join-Path $Root 'skip.json'
$cacheFile = Join-Path $Root 'creditos-analisados.json'
$map = @{}; $cache = @{}
if (Test-Path $skipFile)  { try { (Get-Content $skipFile  -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $map[$_.Name]   = $_.Value } } catch {} }
if (Test-Path $cacheFile) { try { (Get-Content $cacheFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cache[$_.Name] = $_.Value } } catch {} }

function Save-All {
    ($map   | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $skipFile  -Encoding UTF8
    ($cache | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $cacheFile -Encoding UTF8
}

$hit = 0; $miss = 0; $skipped = 0; $i = 0
foreach ($v in $files) {
    $i++
    $sig = "$($v.Length)"
    if (-not $Force -and $cache.ContainsKey($v.Name) -and $cache[$v.Name] -eq $sig) { $skipped++; continue }

    $ent = $map[$v.Name]
    # anime com encerramento (ed) perto do fim ja e tratado pelo app
    if ($ent -and $ent.ed -and $ent.ed[1] -gt 0) { $cache[$v.Name] = $sig; $skipped++; continue }

    $r = Find-Credits $v.FullName
    $cache[$v.Name] = $sig
    if ($r.start -ne $null) {
        $o = [ordered]@{}
        if ($ent -is [System.Collections.IDictionary]) { foreach ($k in $ent.Keys) { $o[$k] = $ent[$k] } }
        elseif ($ent) { $ent.PSObject.Properties | ForEach-Object { $o[$_.Name] = $_.Value } }
        $o['cr'] = @($r.start, [math]::Round($r.dur, 1))
        $map[$v.Name] = $o
        $hit++
        Write-Host ("[{0}/{1}] {2}  ->  {3:N1}s  ({4})" -f $i, $files.Count, $v.Name, $r.start, $r.note) -ForegroundColor Green
    } else {
        $miss++
        Write-Host ("[{0}/{1}] {2}  ->  nao detectado ({3})" -f $i, $files.Count, $v.Name, $r.note) -ForegroundColor DarkYellow
    }
    if (($hit + $miss) % 10 -eq 0) { Save-All }
}
Save-All
Write-Host "`n$hit com creditos detectados | $miss sem deteccao (app usa padrao fim-45s) | $skipped ja analisados" -ForegroundColor Cyan
Write-Host "-> $skipFile"
