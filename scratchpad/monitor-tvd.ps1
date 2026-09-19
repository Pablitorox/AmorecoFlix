<#
  monitor-tvd.ps1 - fica de olho em Downloads\ esperando as temporadas 5-8
  de The Vampire Diaries terminarem de baixar, e importa cada uma pro HD
  (import-serie.ps1) assim que fica pronta. Roda em loop ate as 4 temporadas
  serem importadas ou o prazo maximo estourar.

  Detecta a pasta de cada temporada pelo NUMERO da temporada (no nome da
  pasta "Nª Temporada"/"SNN", ou no nome dos arquivos dentro - mesma logica
  do import-serie.ps1), nao pelo nome do grupo de release (varia).
  "Pronta" = tem >= numero canonico de episodios E tamanho total estavel
  em 2 checagens seguidas (mesmo criterio do mon.ps1 antigo).

  Uso: .\monitor-tvd.ps1 -ApiKey <chave>   (ou deixa .env resolver sozinho)
#>
param(
    [int[]]$Seasons = @(5,6,7,8),
    [string]$ApiKey,
    [int]$TvId = 18165,
    [string]$Show = 'The Vampire Diaries',
    [string]$Downloads = 'C:\Users\William\Downloads',
    [string]$Root = 'E:\AmorecoFlix',
    [int]$CheckMinutes = 10,
    [int]$MaxHours = 20
)
$ProjectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $ProjectRoot 'tmdb-key.ps1')
if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }

$log = Join-Path $PSScriptRoot 'monitor-tvd.log'
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'dd/MM HH:mm:ss'), $msg
    $line | Tee-Object -FilePath $log -Append
}

$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$canonAll = @{ 5 = 22; 6 = 22; 7 = 22; 8 = 16 }   # numero de episodios de cada temporada
$canon = @{}
foreach ($s in $Seasons) { $canon[$s] = $canonAll[$s] }
$done = @{}
$lastSize = @{}
$stable = @{}

Log ("===== Monitor iniciado (temporadas {0}, checagem a cada {1} min, prazo max {2} h) =====" -f (($canon.Keys | Sort-Object) -join ','), $CheckMinutes, $MaxHours)

$deadline = (Get-Date).AddHours($MaxHours)
while ((Get-Date) -lt $deadline -and $done.Count -lt $canon.Count) {

    # mapeia pastas recentes de Downloads pra temporada, pela mesma heuristica
    # do import-serie.ps1 (nome da pasta "Nª Temporada"/"SNN", ou episodio SxxEyy)
    $recentFolders = Get-ChildItem -LiteralPath $Downloads -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-10) }

    $folderBySeason = @{}
    foreach ($f in $recentFolders) {
        $vids = Get-ChildItem -LiteralPath $f.FullName -File -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $vext -contains $_.Extension.ToLower() }
        if (-not $vids) { continue }
        $season = 0
        if ($f.Name -match '(\d{1,2})\s*[' + [char]0x00AA + 'a]?\s*[Tt]emporada') { $season = [int]$matches[1] }
        if ($season -le 0 -and $f.Name -match '[sS]0?(\d{1,2})\b') { $season = [int]$matches[1] }
        if ($season -le 0 -and $f.Name -match '[Ss]eason\s*(\d{1,2})\b') { $season = [int]$matches[1] }
        if ($season -le 0) {
            foreach ($v in $vids) {
                if ($v.Name -match '[sS](\d{1,2})[\s._\-]*[eE]\d') { $season = [int]$matches[1]; break }
                if ($v.Name -match '(\d{1,2})[xX]\d{1,3}') { $season = [int]$matches[1]; break }
            }
        }
        if ($canon.ContainsKey($season) -and -not $done[$season]) {
            $folderBySeason[$season] = @{ Folder = $f; Vids = $vids }
        }
    }

    foreach ($s in $canon.Keys) {
        if ($done[$s]) { continue }
        if (-not $folderBySeason.ContainsKey($s)) {
            Log ("T{0}: pasta ainda nao encontrada em Downloads" -f $s)
            continue
        }
        $info = $folderBySeason[$s]
        $count = $info.Vids.Count
        $size  = ($info.Vids | Measure-Object Length -Sum).Sum

        if ($count -ge $canon[$s] -and $size -gt 0 -and $lastSize[$s] -eq $size) {
            $stable[$s] = $stable[$s] + 1
        } else {
            $stable[$s] = 0
        }
        $lastSize[$s] = $size

        Log ("T{0}: {1}/{2} arquivos, {3:N1} GB, pasta '{4}' (estavel: {5}x)" -f `
             $s, $count, $canon[$s], ($size/1GB), $info.Folder.Name, $stable[$s])

        if ($stable[$s] -ge 2) {
            Log ("T{0} PRONTA - importando pro HD..." -f $s)
            # *>&1 (nao 2>&1): import-serie.ps1 usa Write-Host pra quase tudo,
            # que so vai pro stream de Information (6) - 2>&1 so pega erros
            # e perde os avisos de compatibilidade/progresso.
            $importLog = & (Join-Path $ProjectRoot 'import-serie.ps1') -Src $info.Folder.FullName -Show $Show -TvId $TvId -Season $s -ApiKey $ApiKey -Root $Root *>&1
            $importLog | ForEach-Object { Log "    $_" }
            Log ("T{0} IMPORTADA - confira os avisos de compatibilidade acima (se algum episodio saiu CORROMPIDO/ILEGIVEL de novo, o download veio quebrado de novo)" -f $s)
            $done[$s] = $true
        }
    }

    if ($done.Count -lt $canon.Count) { Start-Sleep -Seconds ($CheckMinutes * 60) }
}

if ($done.Count -eq $canon.Count) {
    Log "===== TODAS as temporadas pedidas foram importadas. Monitor encerrado. ====="
} else {
    $faltando = ($canon.Keys | Where-Object { -not $done[$_] }) -join ','
    Log ("===== Prazo maximo estourou. Faltando: T{0}. Monitor encerrado. =====" -f $faltando)
}
