<#
  organizar-subs.ps1 - junta todas as legendas numa pasta central, igual as thumbs.

  Para cada .srt/.ass/.vtt da biblioteca descobre a que video pertence e move para
    E:\AmorecoFlix\subs\<nome completo do video>.srt        (legenda normal)
    E:\AmorecoFlix\subs\<nome completo do video>.forced.srt (forcada)
    E:\AmorecoFlix\subs\<nome completo do video>.<idioma>.srt

  O app procura a legenda nessa pasta pelo nome do arquivo de video.

  Uso:  .\organizar-subs.ps1              simula (nao mexe em nada), so mostra o plano
        .\organizar-subs.ps1 -Apply      move as legendas para /subs
        .\organizar-subs.ps1 -Apply -CleanEmpty   + apaga pastas "Legendas" que ficarem vazias
#>
param(
    [string]$Root = 'E:\AmorecoFlix',
    [switch]$Apply,
    [switch]$CleanEmpty
)
$WhatIf = -not $Apply
$ErrorActionPreference = 'Continue'

$subsDir = Join-Path $Root 'subs'
if (-not $WhatIf) { New-Item -ItemType Directory -Force -Path $subsDir | Out-Null }
$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$sext = @('.srt','.ass','.ssa','.vtt','.sub')
$SUBDIRS = @('legendas','subs','subtitles','legenda')

function EpOf($n) {
    if ($n -match '[sS]\d{1,2}[\s._\-]*[eE](\d{1,3})') { return [int]$matches[1] }
    if ($n -match '(\d{1,2})\s*x\s*(\d{1,3})') { return [int]$matches[2] }
    if ($n -match 'epis[o\u00f3]dio\s*(\d{1,3})') { return [int]$matches[1] }
    if ($n -match '^\s*(\d{1,3})\b') { return [int]$matches[1] }
    return 0
}
# tira sufixos de legenda p/ comparar com o nome do video
function CoreName($base) {
    ($base -replace '\.(forced|hi|sdh|cc|pt|pt-?br|por|eng|en|spa|es|full|default)$','' `
           -replace '\.(forced|hi|sdh|cc|pt|pt-?br|por|eng|en|spa|es)$','').Trim()
}
function LangSuffix($base) {
    $s = ''
    if ($base -match '\.(forced)$')                 { $s = '.forced' }
    elseif ($base -match '\.(pt-?br|pt|por)$')       { $s = '.pt' }
    elseif ($base -match '\.(eng|en)$')              { $s = '.en' }
    elseif ($base -match '\.(spa|es)$')              { $s = '.es' }
    return $s
}

$srts = Get-ChildItem $Root -Recurse -File | Where-Object {
    $sext -contains $_.Extension.ToLower() -and $_.DirectoryName -ne $subsDir -and $_.Length -ge 200
}
Write-Host "$($srts.Count) legendas encontradas" -ForegroundColor Cyan
$ok = 0; $miss = 0

foreach ($srt in $srts) {
    $dir  = $srt.Directory
    $core = CoreName $srt.BaseName
    $suf  = LangSuffix $srt.BaseName

    # pastas de video candidatas: a propria, ou a pai (se estiver em Legendas/)
    $vidDirs = @($dir.FullName)
    if ($SUBDIRS -contains $dir.Name.ToLower() -and $dir.Parent) { $vidDirs = @($dir.Parent.FullName) }

    $video = $null
    foreach ($vd in $vidDirs) {
        $vids = Get-ChildItem -LiteralPath $vd -File -EA 0 | Where-Object { $vext -contains $_.Extension.ToLower() }
        # 1) mesmo nome base
        $video = $vids | Where-Object { $_.BaseName -eq $core } | Select-Object -First 1
        if ($video) { break }
        # 2) mesmo numero de episodio
        $ep = EpOf $core
        if ($ep -gt 0) {
            $video = $vids | Where-Object { (EpOf $_.BaseName) -eq $ep } | Select-Object -First 1
            if ($video) { break }
        }
    }

    if (-not $video) {
        Write-Host "  ? $($srt.FullName.Replace($Root,''))" -ForegroundColor Yellow
        $miss++; continue
    }

    $dest = Join-Path $subsDir ($video.Name + $suf + $srt.Extension)
    $n = 2
    while (Test-Path -LiteralPath $dest) { $dest = Join-Path $subsDir ($video.Name + $suf + ".$n" + $srt.Extension); $n++ }
    Write-Host ("  {0}  ->  {1}" -f $srt.Name, (Split-Path $dest -Leaf))
    if (-not $WhatIf) {
        try { Move-Item -LiteralPath $srt.FullName -Destination $dest -ErrorAction Stop; $ok++ }
        catch { Write-Host "    FALHOU (arquivo em uso?): $_" -ForegroundColor Red }
    } else { $ok++ }
}

# pastas "Legendas" que ficaram vazias
$emptyDirs = Get-ChildItem $Root -Recurse -Directory | Where-Object {
    $SUBDIRS -contains $_.Name.ToLower() -and -not (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -EA 0)
}
if ($emptyDirs) {
    Write-Host "`nPastas de legenda vazias:" -ForegroundColor Cyan
    $emptyDirs | ForEach-Object { Write-Host "  $($_.FullName)" }
    if ($CleanEmpty -and -not $WhatIf) {
        $emptyDirs | ForEach-Object { try { [IO.Directory]::Delete($_.FullName, $true); Write-Host "  apagada: $($_.Name)" -ForegroundColor Green } catch {} }
    } else {
        Write-Host "  (rode com -CleanEmpty para apaga-las)" -ForegroundColor DarkGray
    }
}

$verbo = if ($WhatIf) { 'seriam movidas' } else { 'movidas' }
Write-Host "`n$ok legendas $verbo  |  $miss sem video correspondente  ->  $subsDir" -ForegroundColor Green
if ($WhatIf) { Write-Host "Simulacao. Rode com -Apply para efetivar." -ForegroundColor Yellow }
