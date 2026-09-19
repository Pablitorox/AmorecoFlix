<#
  consolidar-qualidade.ps1 - quando um episodio tem mais de um arquivo na
  pasta (aconteceu quando re-import trouxe extensao diferente da anterior -
  import-serie.ps1 nao sobrescreve nesse caso), mantem so a versao de MAIOR
  resolucao (bitrate como desempate) e apaga o resto.

  Regra do usuario (18/set/2026): "Se estivermos importando um arquivo de
  qualidade maior, pode remover o antigo. o importante e ter o episodio" -
  roda direto, sem pedir confirmacao, so reporta o que fez.

  Uso: .\consolidar-qualidade.ps1 -Path "<pasta da temporada>" [-WhatIf]
#>
param(
    [Parameter(Mandatory=$true)][string]$FolderPath,
    [switch]$WhatIf
)
$ProjectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $ProjectRoot 'checar-compatibilidade.ps1') -AsLibrary
$ffprobe = Find-Ffprobe

$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$vids = Get-ChildItem -LiteralPath $FolderPath -File | Where-Object { $vext -contains $_.Extension.ToLower() }

$grupos = $vids | Group-Object { [regex]::Match($_.Name, 'S\d{2}E\d{2}').Value } | Where-Object { $_.Name -and $_.Count -gt 1 }

if (-not $grupos) { Write-Host "Nenhum episodio com mais de 1 arquivo - nada a consolidar." -ForegroundColor Green; return }

foreach ($g in $grupos) {
    Write-Host "== $($g.Name) ($($g.Count) versoes) ==" -ForegroundColor Cyan
    $candidatos = foreach ($f in $g.Group) {
        $info = & $ffprobe -v error -select_streams v:0 -show_entries stream=width,height,bit_rate -of csv=p=0 -- "$($f.FullName)" 2>$null
        $w = 0; $h = 0; $br = 0
        if ($info) {
            $parts = $info -split ','
            if ($parts.Count -ge 2) { [int]::TryParse($parts[0], [ref]$w) | Out-Null; [int]::TryParse($parts[1], [ref]$h) | Out-Null }
            if ($parts.Count -ge 3) { [int]::TryParse($parts[2], [ref]$br) | Out-Null }
        }
        [pscustomobject]@{ File = $f; Width = $w; Height = $h; Pixels = ($w * $h); BitRate = $br }
    }
    $ok = @($candidatos | Where-Object { $_.Pixels -gt 0 })
    if (-not $ok) {
        Write-Host "  nenhuma versao legivel (todas corrompidas?) - pulando grupo, resolver manualmente" -ForegroundColor Red
        continue
    }
    $melhor = $ok | Sort-Object Pixels, BitRate -Descending | Select-Object -First 1
    foreach ($c in $candidatos) {
        if ($c.File.FullName -eq $melhor.File.FullName) {
            Write-Host ("  MANTIDO: {0}  ({1}x{2})" -f $c.File.Name, $c.Width, $c.Height) -ForegroundColor Green
        } else {
            $motivo = if ($c.Pixels -le 0) { "ilegivel/corrompido" } else { "$($c.Width)x$($c.Height) - qualidade menor" }
            if ($WhatIf) {
                Write-Host ("  removeria: {0}  ({1})" -f $c.File.Name, $motivo) -ForegroundColor Yellow
            } else {
                Remove-Item -LiteralPath $c.File.FullName -Force
                Write-Host ("  removido: {0}  ({1})" -f $c.File.Name, $motivo) -ForegroundColor Yellow
            }
        }
    }
}
