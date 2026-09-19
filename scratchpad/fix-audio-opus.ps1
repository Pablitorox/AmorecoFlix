<#
  fix-audio-opus.ps1 - troca a faixa de audio Opus (suporte incerto na TV)
  por AAC em todo video de uma pasta, SEM recodificar o video (-c:v copy,
  rapido). Grava num arquivo temporario e so substitui o original se o
  ffmpeg terminar com sucesso E o resultado passar no Get-CompatIssues.

  Uso: .\fix-audio-opus.ps1 -Path "<pasta>"
#>
param(
    [Parameter(Mandatory=$true)][string]$Path
)
$ProjectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $ProjectRoot 'checar-compatibilidade.ps1') -AsLibrary
$ffmpeg = Find-Ffmpeg
$ffprobe = Find-Ffprobe
if (-not $ffmpeg) { Write-Error "ffmpeg nao encontrado"; exit 1 }

$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$vids = Get-ChildItem -LiteralPath $Path -File | Where-Object { $vext -contains $_.Extension.ToLower() }

$n = 0
$fixed = 0
$skipped = 0
$failed = 0
foreach ($v in $vids) {
    $n++
    # -join antes do -match: array (mesmo vazio) vira outro array com -match,
    # que e "falso" num if() so quando vazio E teria que dar match tambem -
    # -join forca string escalar, pra -notmatch devolver booleano de verdade.
    $probe = (& $ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 -- "$($v.FullName)" 2>$null) -join ' '
    if ($probe -notmatch 'opus') {
        Write-Host ("  [{0}/{1}] {2} -- sem audio opus, pulando" -f $n, $vids.Count, $v.Name) -ForegroundColor DarkGray
        $skipped++
        continue
    }

    Write-Host ("  [{0}/{1}] {2} -- convertendo opus -> aac..." -f $n, $vids.Count, $v.Name) -ForegroundColor Cyan
    $tmp = Join-Path $v.DirectoryName ($v.BaseName + '.aacfix.tmp' + $v.Extension)
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }

    & $ffmpeg -y -i "$($v.FullName)" -map 0 -c:v copy -c:a aac -b:a 192k -c:s copy -- "$tmp" 2>$null
    if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -le 0) {
        Write-Host "    FALHOU (ffmpeg nao gerou saida)" -ForegroundColor Red
        $failed++
        continue
    }

    $issues = Get-CompatIssues -File $tmp -Ffprobe $ffprobe -Ffmpeg $ffmpeg
    if ($issues) {
        Write-Host ("    FALHOU (saida com problema: {0})" -f ($issues -join '; ')) -ForegroundColor Red
        Remove-Item -LiteralPath $tmp -Force
        $failed++
        continue
    }

    Remove-Item -LiteralPath $v.FullName -Force
    Rename-Item -LiteralPath $tmp -NewName $v.Name
    Write-Host "    OK - audio trocado pra AAC" -ForegroundColor Green
    $fixed++
}

Write-Host ""
Write-Host ("RESULTADO: {0} convertidos, {1} sem opus (pulados), {2} falharam" -f $fixed, $skipped, $failed) -ForegroundColor Cyan
