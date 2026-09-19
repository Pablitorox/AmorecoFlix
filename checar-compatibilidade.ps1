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

  Alem do codec, tambem faz uma sondagem de INTEGRIDADE: decodifica alguns
  trechos do video (inicio/meio/fim, ou mais pontos com -Deep) pra pegar
  arquivo corrompido/truncado que o ffprobe le o cabecalho normalmente mas
  trava ou da erro no meio (transferencia incompleta, torrent com peca ruim,
  etc). -SkipIntegrity pula essa parte (so codec, mais rapido).

  Uso standalone (analisa a biblioteca toda e gera relatorio):
    .\checar-compatibilidade.ps1                    # varre E:\AmorecoFlix (sondagem rapida: 3 pontos)
    .\checar-compatibilidade.ps1 -Root D:\Midia
    .\checar-compatibilidade.ps1 -Path "<arquivo ou pasta especifica>"
    .\checar-compatibilidade.ps1 -Deep               # varredura minuciosa: 11 pontos por video (mais lento)
    .\checar-compatibilidade.ps1 -Csv                # tambem grava um .csv

  Uso como biblioteca (chamado por import-serie.ps1 / transferir-hd.ps1
  logo apos copiar, pra avisar NA HORA de um arquivo problematico):
    . "$PSScriptRoot\checar-compatibilidade.ps1" -AsLibrary
    $issues = Get-CompatIssues -File $destino -Ffprobe $ffprobe -Ffmpeg $ffmpeg
#>
param(
    # $LibRoot/$ScanPath (nao $Root/$Path): dot-source com -AsLibrary roda no
    # MESMO escopo de quem chama, entao um param() com nome comum tipo $Root
    # ou $Path sobrescreveria silenciosamente a variavel do script chamador
    # (ja aconteceu - import-serie.ps1 e fix-audio-opus.ps1 tem seus proprios
    # $Root/$Path). Alias mantem -Root/-Path funcionando na CLI standalone.
    [Alias('Root')][string]$LibRoot = 'E:\AmorecoFlix',
    [Alias('Path')][string]$ScanPath,
    [switch]$Csv,
    [switch]$Deep,
    [switch]$SkipIntegrity,
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

function Find-Ffmpeg {
    $p = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    if (-not $p) {
        $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($b) { $p = $b.FullName }
    }
    return $p
}

# Decodifica trechos do video pra pegar corrupcao/truncamento que o ffprobe
# (so le cabecalho/metadados) nao detecta. -Deep sonda mais pontos - mais
# lento, mas pega dano isolado no meio de um arquivo grande.
function Test-FileIntegrity {
    param(
        [Parameter(Mandatory=$true)][string]$File,
        [string]$Ffmpeg,
        [string]$Ffprobe,
        [switch]$Deep
    )
    if (-not $Ffmpeg)  { $Ffmpeg  = Find-Ffmpeg }
    if (-not $Ffprobe) { $Ffprobe = Find-Ffprobe }
    if (-not $Ffmpeg -or -not $Ffprobe) { return @() }

    $durStr = & $Ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$File" 2>$null
    $dur = 0.0
    if ($durStr) {
        [double]::TryParse(
            ($durStr -replace ',', '.'),
            [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$dur
        ) | Out-Null
    }
    if ($dur -le 1) { return @('duracao invalida/zero - possivel arquivo corrompido ou truncado') }

    if ($Deep) {
        $points = @(0.02,0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,0.97)
        $span = 2.0
    } else {
        $points = @(0.05,0.50,0.95)
        $span = 1.0
    }

    $issues = @()
    foreach ($pct in $points) {
        $ss = [Math]::Max(0, [Math]::Min(($dur * $pct), ($dur - $span - 0.2)))
        $err = & $Ffmpeg -v error -ss $ss -t $span -i "$File" -map 0:v:0 -f null - 2>&1
        # aviso do muxer nulo sobre dts apos seek em MKV - nao e erro de
        # decodificacao e nao impede reproducao (falso positivo comum)
        $err = @($err | Where-Object { $_ -notmatch 'non monotonically increasing dts' })
        if ($err) {
            $primeira = @($err)[0]
            $issues += ("decodificacao falhou perto de {0:P0} do video ({1}s): {2}" -f $pct, [Math]::Round($ss,0), $primeira)
        }
    }
    return $issues
}

function Get-CompatIssues {
    param(
        [Parameter(Mandatory=$true)][string]$File,
        [string]$Ffprobe,
        [string]$Ffmpeg,
        [switch]$SkipIntegrity,
        [switch]$Deep
    )
    if (-not $Ffprobe) { $Ffprobe = Find-Ffprobe }
    if (-not $Ffprobe) { return @('ffprobe nao encontrado - nao foi possivel checar') }

    $json = & $Ffprobe -v error -show_entries stream=codec_type,codec_name,profile,pix_fmt,width,height,duration:format=duration -of json -- "$File" 2>$null
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
        # TRUNCADO: o cabecalho promete X segundos (format.duration) mas a
        # faixa de video so tem uma fracao disso (ex: 4min de 42min). O moov
        # existe, entao nada mais acusa - e seek alem do fim nao da erro no
        # decode, por isso a sondagem de integridade nao pega sozinha.
        $inv = [Globalization.CultureInfo]::InvariantCulture
        $fd = 0.0; $vd = 0.0
        $okF = $info.format -and [double]::TryParse([string]$info.format.duration, [Globalization.NumberStyles]::Float, $inv, [ref]$fd)
        $okV = [double]::TryParse([string]$vstream.duration, [Globalization.NumberStyles]::Float, $inv, [ref]$vd)
        if ($okF -and $okV -and $fd -gt 60 -and $vd -lt ($fd * 0.9)) {
            $issues += ("TRUNCADO: video tem {0:N0}s de {1:N0}s declarados ({2:P0}) - download/copia incompleto" -f $vd, $fd, ($vd / $fd))
        }
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

    if (-not $SkipIntegrity) {
        $issues += Test-FileIntegrity -File $File -Ffmpeg $Ffmpeg -Ffprobe $Ffprobe -Deep:$Deep
    }
    return $issues
}

if ($AsLibrary) { return }

# ---------------------------------------------------------------------------
# Modo standalone: varre $Path (arquivo/pasta) ou $Root inteiro e reporta.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$ffprobe = Find-Ffprobe
$ffmpeg  = Find-Ffmpeg
if (-not $ffprobe) { Write-Error "ffprobe nao encontrado. Rode: winget install Gyan.FFmpeg"; exit 1 }

$alvo = if ($ScanPath) { $ScanPath } else { $LibRoot }
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
    $issues = Get-CompatIssues -File $v.FullName -Ffprobe $ffprobe -Ffmpeg $ffmpeg -SkipIntegrity:$SkipIntegrity -Deep:$Deep
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
