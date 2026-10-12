<#
  skip-anime.ps1 - marca o intervalo da ABERTURA (e encerramento) de cada
  episodio de anime, usando a API publica AniSkip (dados da comunidade).

  Gera  E:\AmorecoFlix\skip.json  =  { "<nome do arquivo>": { "op":[ini,fim], "ed":[ini,fim] } }  (segundos)
  O app AmorecoFlix mostra o botao "Pular abertura" quando o tempo cai nesse intervalo.

  Precisa do MAL id de cada anime (MyAnimeList). Adicione em $ANIME_MAL abaixo.

  Uso:  .\skip-anime.ps1
#>
param([string]$Root = 'E:\AmorecoFlix')
$ErrorActionPreference = 'Continue'

# nome da pasta (normalizado) -> MAL id
$ANIME_MAL = @{
    'fma brotherhood'                  = 5114
    'fullmetal alchemist brotherhood'  = 5114
    'death parade'                     = 28223
    'bleach sennen kessen hen'         = 41467
    'bleach tybw'                      = 41467
    # adicione: 'nome da pasta em minusculo' = <mal id>
}

. (Join-Path $PSScriptRoot 'lib.ps1')
$ffprobe = Find-FfTool 'ffprobe'
if (-not $ffprobe) { Write-Error "ffprobe nao encontrado"; exit 1 }

function Norm($s) { ("$s".ToLower() -replace '[^\p{Ll}\p{Nd} ]',' ' -replace '\s+',' ').Trim() }
function Get-Ep($n) {
    if ($n -match '[sS]\d{1,2}[\s._\-]*[eE](\d{1,3})') { return [int]$matches[1] }
    if ($n -match 'epis[oó]dio\s*(\d{1,3})') { return [int]$matches[1] }
    if ($n -match '^\s*(\d{1,3})\b') { return [int]$matches[1] }
    return 0
}

$skipFile = Join-Path $Root 'skip.json'
$map = @{}
if (Test-Path $skipFile) {
    try { (Get-Content $skipFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $map[$_.Name] = $_.Value } } catch {}
}

$animes = Join-Path $Root 'Animes'
$vext = @('.mkv','.mp4','.avi','.m4v')
$hit = 0; $none = 0; $noMal = 0

foreach ($showDir in (Get-ChildItem -LiteralPath $animes -Directory -EA 0)) {
    $mal = $ANIME_MAL[(Norm $showDir.Name)]
    if (-not $mal) { Write-Host "  (sem MAL id) $($showDir.Name)" -ForegroundColor DarkGray; $noMal++; continue }
    Write-Host "== $($showDir.Name)  (MAL $mal) ==" -ForegroundColor Cyan

    $vids = Get-ChildItem -LiteralPath $showDir.FullName -Recurse -File | Where-Object { $vext -contains $_.Extension.ToLower() }
    foreach ($v in ($vids | Sort-Object Name)) {
        $ep = Get-Ep $v.BaseName
        if ($ep -le 0) { continue }
        $cur = $map[$v.Name]
        if ($cur -and ($cur.op -or $cur.ed)) { continue }   # ja tem (entrada so com "cr" nao conta)

        $dur = 0
        try { $dur = [double](& $ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$($v.FullName)" 2>$null) } catch {}
        if ($dur -le 0) { $dur = 1440 }

        $url = "https://api.aniskip.com/v2/skip-times/$mal/$ep`?types=op&types=mixed-op&types=ed&episodeLength=$([int]$dur)"
        $json = curl.exe -s --max-time 15 $url
        try { $resp = $json | ConvertFrom-Json } catch { $resp = $null }

        if (-not ($resp -and $resp.found)) { $none++; continue }

        $entry = @{}
        foreach ($r in $resp.results) {
            $t = $r.skipType
            if ($t -eq 'mixed-op') { $t = 'op' }
            $st = [double]$r.interval.startTime
            $en = [double]$r.interval.endTime
            $len = $en - $st
            $ok = $false
            if ($t -eq 'op') {
                # abertura: comeca na 1a metade, dura 60-135s
                if ($st -lt ($dur * 0.5) -and $len -ge 55 -and $len -le 135) { $ok = $true }
            } elseif ($t -eq 'ed') {
                # encerramento: comeca depois de 55% do episodio
                if ($st -gt ($dur * 0.55) -and $en -lt ($dur - 5) -and $len -ge 40 -and $len -le 135) { $ok = $true }
            }
            if ($ok) { $entry[$t] = @([math]::Round($st, 1), [math]::Round($en, 1)) }
        }
        if ($entry.Count -gt 0) {
            # mescla com o que ja existe (ex.: "cr" do detectar-creditos.ps1) em vez de substituir
            $o = [ordered]@{}
            if ($cur -is [System.Collections.IDictionary]) { foreach ($k in $cur.Keys) { $o[$k] = $cur[$k] } }
            elseif ($cur) { $cur.PSObject.Properties | ForEach-Object { $o[$_.Name] = $_.Value } }
            foreach ($k in $entry.Keys) { $o[$k] = $entry[$k] }
            $map[$v.Name] = $o
            $hit++
            $op = $entry['op']
            Write-Host ("  E{0:D2}  OP {1}-{2}s" -f $ep, $(if($op){$op[0]}else{'-'}), $(if($op){$op[1]}else{'-'}))
        }
        Start-Sleep -Milliseconds 250
    }
}

($map | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $skipFile -Encoding UTF8
Write-Host "`n$hit episodios com abertura marcada  |  $none sem dados  |  $noMal animes sem MAL id" -ForegroundColor Green
Write-Host "-> $skipFile"
