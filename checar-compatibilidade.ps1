<#
  checar-compatibilidade.ps1 - sinaliza videos com codec/audio que o player
  (Samsung Tizen AVPlay, TV UN50DU7700 Tizen 9 - ver memoria "tizen-env")
  normalmente NAO abre.

  Isso e HEURISTICO: nao existe lista oficial completa de codecs suportados
  pelo AVPlay. As regras abaixo vem de gotchas conhecidos (DTS/TrueHD sem
  licenca de audio, Xvid/DivX antigo em .avi, codecs de video obsoletos tipo
  WMV1/2, RealVideo, H.263...). Se um arquivo sinalizado tocar normal, ou um
  arquivo nao sinalizado falhar, anota o nome aqui e ajusta as listas
  $VIDEO_ALTO_RISCO / $VIDEO_VERIFICAR / $AUDIO_ALTO_RISCO / $AUDIO_VERIFICAR.

  Uso standalone (analisa a biblioteca toda e gera relatorio):
    .\checar-compatibilidade.ps1                    # varre E:\AmorecoFlix
    .\checar-compatibilidade.ps1 -Root D:\Midia
    .\checar-compatibilidade.ps1 -Path "<arquivo ou pasta especifica>"
    .\checar-compatibilidade.ps1 -Csv               # tambem grava um .csv

  Uso como biblioteca (chamado por import-serie.ps1 / transferir-hd.ps1
  logo apos copiar, pra avisar NA HORA de um arquivo problematico):
    . "$PSScriptRoot\checar-compatibilidade.ps1" -AsLibrary
    $issues = Get-CompatIssues -File $destino -Ffprobe $ffprobe
#>
param(
    [string]$Root = 'E:\AmorecoFlix',
    [string]$Path,
    [switch]$Csv,
    [switch]$AsLibrary
)

$VIDEO_EXT = @('.mp4','.mkv','.avi','.mov','.m4v','.ts','.webm','.wmv','.flv',
               '.mpg','.mpeg','.3gp','.m2ts','.vob','.ogv')

# codecs de video praticamente garantidos de falhar no AVPlay da TV
$VIDEO_ALTO_RISCO = @('msmpeg4v3','msmpeg4v2','msmpeg4v1','wmv1','wmv2','flv1',
                      'rv10','rv20','rv30','rv40','h263','h263p','indeo3','indeo4','indeo5')
# suporte incerto nesse modelo/versao de Tizen - testar antes de confiar
$VIDEO_VERIFICAR  = @('av1','vp8','wmv3','vc1','mpeg1video')

# audio que a TV Samsung tipicamente nao tem licenca pra decodificar
# (nesse caso o prepareAsync costuma falhar inteiro, nao so tocar mudo)
$AUDIO_ALTO_RISCO = @('dts','dts-hd','truehd','eac3_ddp')  # 'eac3_ddp' raro, so por seguranca
# suporte incerto
$AUDIO_VERIFICAR  = @('flac','vorbis','opus','wmav1','wmav2')

function Find-Ffprobe {
    $p = (Get-Command ffprobe -ErrorAction SilentlyContinue).Source
    if (-not $p) {
        $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffprobe.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($b) { $p = $b.FullName }
    }
    return $p
}

function Get-CompatIssues {
    param(
        [Parameter(Mandatory=$true)][string]$File,
        [string]$Ffprobe
    )
    if (-not $Ffprobe) { $Ffprobe = Find-Ffprobe }
    if (-not $Ffprobe) { return @('ffprobe nao encontrado - nao foi possivel checar') }

    $json = & $Ffprobe -v error -show_entries stream=codec_type,codec_name,profile,pix_fmt,width,height -of json -- "$File" 2>$null
    if (-not $json) { return @('CORROMPIDO/ILEGIVEL (ffprobe nao leu o arquivo)') }
    try { $info = $json | ConvertFrom-Json } catch { return @('CORROMPIDO/ILEGIVEL (saida invalida do ffprobe)') }
    if (-not $info.streams) { return @('CORROMPIDO/ILEGIVEL (sem faixas)') }

    $issues = @()
    $vstream = $info.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
    $astreams = @($info.streams | Where-Object { $_.codec_type -eq 'audio' })
    $ext = [IO.Path]::GetExtension($File).ToLower()

    if (-not $vstream) {
        $issues += 'sem faixa de video'
    } else {
        $vcodec = $vstream.codec_name
        if ($VIDEO_ALTO_RISCO -contains $vcodec) {
            $issues += "video '$vcodec' - codec antigo normalmente NAO suportado pela TV"
        } elseif ($vcodec -eq 'mpeg4' -and $ext -eq '.avi') {
            $issues += "video 'mpeg4' em .avi - provavel Xvid/DivX antigo, risco alto"
        } elseif ($VIDEO_VERIFICAR -contains $vcodec) {
            $issues += "video '$vcodec' - suporte incerto nessa TV, testar"
        }
    }

    if ($astreams.Count -eq 0) {
        $issues += 'sem faixa de audio'
    } else {
        foreach ($a in $astreams) {
            if ($AUDIO_ALTO_RISCO -contains $a.codec_name) {
                $issues += "audio '$($a.codec_name)' - TV geralmente sem licenca, tende a falhar (nao so mudo)"
            } elseif ($AUDIO_VERIFICAR -contains $a.codec_name) {
                $issues += "audio '$($a.codec_name)' - suporte incerto, testar"
            }
        }
    }
    return $issues
}

if ($AsLibrary) { return }

# ---------------------------------------------------------------------------
# Modo standalone: varre $Path (arquivo/pasta) ou $Root inteiro e reporta.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$ffprobe = Find-Ffprobe
if (-not $ffprobe) { Write-Error "ffprobe nao encontrado. Rode: winget install Gyan.FFmpeg"; exit 1 }

$alvo = if ($Path) { $Path } else { $Root }
if (-not (Test-Path -LiteralPath $alvo)) { Write-Error "nao existe: $alvo"; exit 1 }

$item = Get-Item -LiteralPath $alvo
if ($item.PSIsContainer) {
    $vids = Get-ChildItem -LiteralPath $alvo -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $VIDEO_EXT -contains $_.Extension.ToLower() -and
                $_.DirectoryName -notmatch '\\thumbs(\\|$)' -and
                $_.DirectoryName -notmatch '\\subs(\\|$)' -and
                $_.Length -ge 8MB
            }
} else {
    $vids = @($item)
}
Write-Host "$($vids.Count) videos para checar em $alvo" -ForegroundColor Cyan

$relatorio = @()
$n = 0
foreach ($v in $vids) {
    $n++
    Write-Host ("  [{0}/{1}] {2}" -f $n, $vids.Count, $v.Name) -NoNewline
    $issues = Get-CompatIssues -File $v.FullName -Ffprobe $ffprobe
    if ($issues) {
        Write-Host "  <-- SUSPEITO" -ForegroundColor Yellow
        foreach ($i in $issues) { Write-Host "        $i" -ForegroundColor Yellow }
        $relatorio += [pscustomobject]@{ Arquivo = $v.FullName; Problemas = ($issues -join ' | ') }
    } else {
        Write-Host "  ok" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host ("RESULTADO: {0}/{1} arquivos suspeitos" -f $relatorio.Count, $vids.Count) -ForegroundColor Cyan
if ($Csv -and $relatorio.Count -gt 0) {
    $logDir = Join-Path $PSScriptRoot 'scratchpad'
    New-Item -ItemType Directory -Force -Path $logDir -EA 0 | Out-Null
    $out = Join-Path $logDir ("compat_" + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.csv')
    $relatorio | Export-Csv -LiteralPath $out -NoTypeInformation -Encoding UTF8
    Write-Host "Relatorio: $out" -ForegroundColor Green
}
