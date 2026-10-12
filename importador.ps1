<#
  importador.ps1 - app (janela) para passar episodios de Downloads para o HD.

  Arraste pastas/arquivos de video para a janela (ou use os botoes), confira a
  serie detectada e clique Importar. COPIA (nao move).

  ANTES de copiar, analisa cada arquivo:
    - integridade (corrompido/truncado/sem indice) e codecs de risco p/ a TV
    - idioma: tem audio PT-BR? (so dublado/dual interessa)
    - espaco livre no HD
    - comparacao com os outros episodios da pasta (tamanho, resolucao, duracao)
    - episodios que faltam na temporada (usa a contagem do TMDB)
    - versao ja existente no HD: so substitui se for melhor (e nunca troca
      PT-BR por versao sem PT-BR); apaga a versao pior
    - duplicados dentro do proprio lote
    - (opcional) IA revisa o relatorio tecnico - precisa de ANTHROPIC_API_KEY no .env
  DEPOIS de copiar: confere tamanho + integridade do arquivo copiado, copia
  legendas, gera a miniatura (still do TMDB ou frame do video) e as capas.

  Abrir: duplo clique em Importador.bat
  Teste sem janela:  -Headless -Paths <pasta/arquivo> -ShowName <serie> [-HdRoot <biblioteca de teste>] [-NoAI]
#>
param(
    [switch]$Headless,
    [string[]]$Paths,
    [string]$ShowName,
    [string]$HdRoot = 'E:\AmorecoFlix',   # NAO usar $LibRoot: o checar-compatibilidade.ps1 sobrescreve no dot-source
    [switch]$NoAI,
    [int]$TvId = 0            # so no modo -Headless (a janela detecta pelo TMDB)
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $Headless) { [System.Windows.Forms.Application]::EnableVisualStyles() }

$ORD = [char]0x00AA
$DefaultDl = Join-Path $env:USERPROFILE 'Downloads'
$vext = @('.mkv','.mp4','.avi','.m4v','.ts')
$sext = @('.srt','.ass','.ssa','.vtt')
$RANK = @{ 'OK' = 0; 'ATENCAO' = 1; 'BLOQUEIO' = 2 }

. (Join-Path $PSScriptRoot 'tmdb-key.ps1')
$tmdbKey = Get-TmdbApiKey

function Get-EnvValue($name) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v) { return $v }
    $f = Join-Path $PSScriptRoot '.env'
    if (Test-Path -LiteralPath $f) {
        $l = Get-Content -LiteralPath $f -EA 0 | Where-Object { $_ -match ('^\s*' + $name + '\s*=') } | Select-Object -First 1
        if ($l) { return (($l -split '=', 2)[1]).Trim().Trim('"') }
    }
    return $null
}
$anthropicKey = Get-EnvValue 'ANTHROPIC_API_KEY'
$geminiKey = Get-EnvValue 'GEMINI_API_KEY'     # alternativa gratuita (Google AI Studio)
$aiName = if ($anthropicKey) { 'Claude' } elseif ($geminiKey) { 'Gemini' } else { '' }

$ffmpeg = (Get-Command ffmpeg -EA 0).Source
if (-not $ffmpeg) { $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffmpeg.exe -EA 0 | Select-Object -First 1; if ($b) { $ffmpeg = $b.FullName } }
$ffprobe = $null
if ($ffmpeg) { $ffprobe = Join-Path (Split-Path $ffmpeg) 'ffprobe.exe' }
$compatLib = Join-Path $PSScriptRoot 'checar-compatibilidade.ps1'
if (Test-Path -LiteralPath $compatLib) { . $compatLib -AsLibrary }

$script:items = New-Object System.Collections.ArrayList
$script:tvId = 0
$script:busy = $false
$script:seasonCache = @{}
$script:sibCache = @{}
$script:showText = $ShowName

# ---------- UI ----------
if (-not $Headless) {
    $form = New-Object Windows.Forms.Form
    $form.Text = 'AmorecoFlix - Importador'
    $form.Size = New-Object Drawing.Size(1120, 760)
    $form.StartPosition = 'CenterScreen'
    $form.AllowDrop = $true
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)

    $lblDrop = New-Object Windows.Forms.Label
    $lblDrop.Text = 'Arraste aqui as pastas/arquivos de video baixados (ou use os botoes)'
    $lblDrop.TextAlign = 'MiddleCenter'; $lblDrop.BorderStyle = 'FixedSingle'
    $lblDrop.SetBounds(12, 12, 1080, 60); $lblDrop.AllowDrop = $true
    $form.Controls.Add($lblDrop)

    $btnPasta = New-Object Windows.Forms.Button; $btnPasta.Text = 'Escolher pasta...'; $btnPasta.SetBounds(12, 80, 150, 32)
    $btnArq   = New-Object Windows.Forms.Button; $btnArq.Text = 'Escolher arquivos...'; $btnArq.SetBounds(170, 80, 170, 32)
    $btnLimpa = New-Object Windows.Forms.Button; $btnLimpa.Text = 'Limpar lista'; $btnLimpa.SetBounds(348, 80, 120, 32)
    $chkIA = New-Object Windows.Forms.CheckBox; $chkIA.SetBounds(490, 84, 400, 26)
    if ($aiName) { $chkIA.Text = "Revisar com IA ($aiName)"; $chkIA.Checked = $true }
    else { $chkIA.Text = 'Revisar com IA (defina GEMINI_API_KEY ou ANTHROPIC_API_KEY no .env)'; $chkIA.Enabled = $false }
    $form.Controls.AddRange(@($btnPasta, $btnArq, $btnLimpa, $chkIA))

    $lblSerie = New-Object Windows.Forms.Label; $lblSerie.Text = 'Serie na biblioteca:'; $lblSerie.SetBounds(12, 125, 150, 24)
    $cmbSerie = New-Object Windows.Forms.ComboBox; $cmbSerie.SetBounds(165, 122, 480, 28); $cmbSerie.DropDownStyle = 'DropDown'
    $btnBusca = New-Object Windows.Forms.Button; $btnBusca.Text = 'Buscar no TMDB'; $btnBusca.SetBounds(655, 120, 150, 30)
    $lblTv = New-Object Windows.Forms.Label; $lblTv.Text = ''; $lblTv.SetBounds(815, 125, 200, 24)
    $form.Controls.AddRange(@($lblSerie, $cmbSerie, $btnBusca, $lblTv))

    $lv = New-Object Windows.Forms.ListView
    $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.GridLines = $true
    $lv.SetBounds(12, 160, 1080, 230)
    [void]$lv.Columns.Add('Arquivo', 330); [void]$lv.Columns.Add('T', 35); [void]$lv.Columns.Add('Ep', 40)
    [void]$lv.Columns.Add('Tamanho', 80); [void]$lv.Columns.Add('Res.', 60); [void]$lv.Columns.Add('Audio', 90)
    [void]$lv.Columns.Add('Legendas', 100); [void]$lv.Columns.Add('Status', 330)
    $form.Controls.Add($lv)

    $btnAn  = New-Object Windows.Forms.Button; $btnAn.Text = 'Analisar'; $btnAn.SetBounds(12, 400, 130, 38); $btnAn.Enabled = $false
    $btnImp = New-Object Windows.Forms.Button; $btnImp.Text = 'Importar para o HD'; $btnImp.SetBounds(150, 400, 200, 38); $btnImp.Enabled = $false
    $prog = New-Object Windows.Forms.ProgressBar; $prog.Maximum = 1000; $prog.SetBounds(360, 406, 732, 26)
    $form.Controls.AddRange(@($btnAn, $btnImp, $prog))

    $log = New-Object Windows.Forms.TextBox
    $log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'
    $log.Font = New-Object Drawing.Font('Consolas', 9)
    $log.SetBounds(12, 450, 1080, 260)
    $form.Controls.Add($log)
} else {
    $prog = [pscustomobject]@{ Value = 0 }
}

function Log($m) {
    if ($Headless) { Write-Host $m } else { $log.AppendText("$m`r`n"); [Windows.Forms.Application]::DoEvents() }
}
function Pump { if (-not $Headless) { [Windows.Forms.Application]::DoEvents() } }
function Get-ShowText { if ($Headless) { $script:showText } else { $cmbSerie.Text.Trim() } }
function Ask-Yes($msg, $title) {
    if ($Headless) { Log "[confirmacao automatica: SIM] $title"; return $true }
    return ([Windows.Forms.MessageBox]::Show($msg, $title, 'YesNo', 'Warning') -eq 'Yes')
}

# ---------- helpers ----------
function Parse-Ep($name) {
    if ($name -match '[sS](\d{1,2})[\s._\-]*[eE](\d{1,3})') { return @([int]$matches[1], [int]$matches[2]) }
    if ($name -match '(?<!\d)(\d{1,2})[xX](\d{1,3})(?!\d)') { return @([int]$matches[1], [int]$matches[2]) }
    return @(0, 0)
}
function Guess-Show($name) {
    $n = [IO.Path]::GetFileNameWithoutExtension($name)
    if ($n -match '^(.*?)[\s._\-]*(?:[sS]\d{1,2}[\s._\-]*[eE]\d|\d{1,2}[xX]\d)') { $n = $matches[1] }
    ($n -replace '[._]', ' ').Trim()
}
function Match-Ep($name, $s, $e) { [regex]::IsMatch($name, "(?i)S0*$s[\s._\-]*E0*$e(?![0-9])") }
function Norm($s) { ($s.ToLower() -replace '[^a-z0-9]', '') }
function Median($a) { $s = @($a | Sort-Object); if (-not $s.Count) { return 0 }; return $s[[int][Math]::Floor(($s.Count - 1) / 2)] }
function MB($b) { '{0:N0} MB' -f ($b / 1MB) }
function Library-Shows {
    if (-not (Test-Path -LiteralPath $HdRoot)) { return }   # HD desconectado: Join-Path estoura se a unidade nao existe
    $d = Join-Path $HdRoot 'Series'
    if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -Directory | Sort-Object Name | ForEach-Object Name }
}
function Is-Flat($show) {
    if (-not (Test-Path -LiteralPath $HdRoot)) { return $false }
    $sd =Join-Path (Join-Path $HdRoot 'Series') $show
    if (-not (Test-Path -LiteralPath $sd)) { return $false }
    return [bool](Get-ChildItem -LiteralPath $sd -File -EA 0 | Where-Object { $vext -contains $_.Extension.ToLower() })
}
function Get-DestDir($show, $season) {
    $sd = Join-Path (Join-Path $HdRoot 'Series') $show
    if (Is-Flat $show) { return $sd }
    return (Join-Path $sd ("$show - $season$ORD Temporada"))
}
function Res-Label($w, $h) {
    if ($w -ge 1800) { return '1080p' }; if ($w -ge 1200) { return '720p' }
    if ($w -ge 900) { return '576p' }; if ($w -gt 0) { return '480p' }; return '?'
}
function Is-Pt($a) { ($a.Lang -in @('por', 'pt', 'pob', 'ptbr', 'pt-br')) -or ($a.Title -match '(?i)portugu|dublad|pt-?br') }

function Probe-File($f) {
    if (-not $ffprobe) { return $null }
    $raw = (& $ffprobe -v error -print_format json -show_format -show_streams -- $f 2>$null) | Out-String
    if (-not $raw.Trim()) { return $null }
    try { $o = $raw | ConvertFrom-Json } catch { return $null }
    if (-not $o.streams) { return $null }
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $nf = [Globalization.NumberStyles]::Float
    $v = $o.streams | Where-Object { $_.codec_type -eq 'video' -and $_.disposition.attached_pic -ne 1 } | Select-Object -First 1
    $dur = 0.0; $br = 0.0
    if ($o.format) {
        [void][double]::TryParse([string]$o.format.duration, $nf, $inv, [ref]$dur)
        [void][double]::TryParse([string]$o.format.bit_rate, $nf, $inv, [ref]$br)
    }
    $aud = @($o.streams | Where-Object { $_.codec_type -eq 'audio' } | ForEach-Object {
        $l = ''; $t = ''
        if ($_.tags) { $l = [string]$_.tags.language; $t = [string]$_.tags.title }
        if (-not $l) { $l = 'und' }
        [pscustomobject]@{ Lang = $l.ToLower(); Title = $t; Codec = $_.codec_name; Ch = $_.channels }
    })
    $subs = @($o.streams | Where-Object { $_.codec_type -eq 'subtitle' } | ForEach-Object {
        $l = ''; if ($_.tags) { $l = [string]$_.tags.language }; if (-not $l) { $l = 'und' }; $l.ToLower()
    })
    $w = 0; $h = 0; $vc = ''
    if ($v) { $w = [int]$v.width; $h = [int]$v.height; $vc = $v.codec_name }
    [pscustomobject]@{
        W = $w; H = $h; Pixels = ($w * $h); VCodec = $vc; Bitrate = $br; Dur = $dur
        Audio = $aud; Subs = $subs; HasPt = [bool](@($aud | Where-Object { Is-Pt $_ }).Count)
    }
}

function Tmdb-Search($q) {
    if (-not $tmdbKey -or -not $q) { return @() }
    try {
        $u = 'https://api.themoviedb.org/3/search/tv?api_key=' + $tmdbKey + '&language=pt-BR&query=' + [uri]::EscapeDataString($q)
        return @((Invoke-RestMethod -Uri $u -TimeoutSec 15).results)
    } catch { Log "TMDB: $($_.Exception.Message)"; return @() }
}
function Get-SeasonInfo($season) {
    if ($script:tvId -le 0 -or -not $tmdbKey) { return $null }
    if ($script:seasonCache.ContainsKey($season)) { return $script:seasonCache[$season] }
    $r = $null
    try {
        $u = 'https://api.themoviedb.org/3/tv/{0}/season/{1}?api_key={2}&language=pt-BR' -f $script:tvId, $season, $tmdbKey
        $r = Invoke-RestMethod -Uri $u -TimeoutSec 25
    } catch {}
    $script:seasonCache[$season] = $r
    return $r
}

function Refresh-List {
    if ($Headless) { return }
    $lv.Items.Clear()
    foreach ($it in $script:items) {
        $li = New-Object Windows.Forms.ListViewItem($it.Name)
        [void]$li.SubItems.Add([string]$it.Season); [void]$li.SubItems.Add([string]$it.Ep)
        [void]$li.SubItems.Add((MB $it.Size))
        $res = ''; $au = ''; $sb = ''
        if ($it.Info) {
            $res = Res-Label $it.Info.W $it.Info.H
            $au = (@($it.Info.Audio | ForEach-Object { $_.Lang } | Select-Object -Unique) -join ',')
            $sb = (@($it.Info.Subs | Select-Object -Unique) -join ',')
        }
        [void]$li.SubItems.Add($res); [void]$li.SubItems.Add($au); [void]$li.SubItems.Add($sb)
        $st = $it.Status
        if ($it.Action -eq 'skip') { $st = "PULAR - $($it.SkipReason)" }
        elseif ($it.Status -ne 'OK' -and $it.Notes.Count) { $st = "$($it.Status) - $($it.Notes[0])" }
        [void]$li.SubItems.Add($st)
        if ($it.Season -le 0 -or $it.Ep -le 0 -or $it.Status -eq 'BLOQUEIO') { $li.ForeColor = [Drawing.Color]::Red }
        elseif ($it.Action -eq 'skip') { $li.ForeColor = [Drawing.Color]::Gray }
        elseif ($it.Status -eq 'ATENCAO') { $li.ForeColor = [Drawing.Color]::DarkOrange }
        [void]$lv.Items.Add($li)
    }
    $btnImp.Enabled = ($script:items.Count -gt 0); $btnAn.Enabled = ($script:items.Count -gt 0)
}

function Add-Paths($paths) {
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $isDir = (Get-Item -LiteralPath $p).PSIsContainer
        $files = if ($isDir) {
            Get-ChildItem -LiteralPath $p -Recurse -File | Where-Object { $vext -contains $_.Extension.ToLower() -and $_.Length -gt 8MB }
        } else { Get-Item -LiteralPath $p }
        $folderSeason = 0
        $dirName = if ($isDir) { Split-Path $p -Leaf } else { '' }
        if ($dirName -match ('(\d{1,2})\s*[' + $ORD + 'a]?\s*Temporada')) { $folderSeason = [int]$matches[1] }
        elseif ($dirName -match '(?<![a-zA-Z0-9])[sS](\d{1,2})(?![a-zA-Z0-9])') { $folderSeason = [int]$matches[1] }
        foreach ($f in $files) {
            if ($vext -notcontains $f.Extension.ToLower()) { continue }
            if ($script:items | Where-Object { $_.Path -eq $f.FullName }) { continue }
            $se = Parse-Ep $f.Name
            if ($se[0] -le 0 -and $folderSeason -gt 0) { $se[0] = $folderSeason }
            if ($se[1] -le 0 -and $f.Name -match '^\s*(\d{1,3})\s*[-.\s]') { $se[1] = [int]$matches[1] }
            [void]$script:items.Add([pscustomobject]@{
                Name = $f.Name; Path = $f.FullName; Season = $se[0]; Ep = $se[1]; Size = $f.Length
                Info = $null; Status = 'OK'; Notes = (New-Object System.Collections.ArrayList)
                Action = 'copy'; SkipReason = ''; Existing = @(); Dst = ''
            })
        }
    }
    $sorted = @($script:items | Sort-Object Season, Ep)
    $script:items = New-Object System.Collections.ArrayList
    foreach ($s in $sorted) { [void]$script:items.Add($s) }
    Refresh-List
    if (-not $Headless -and $script:items.Count -gt 0 -and -not $cmbSerie.Text) { Detect-Show }
}

function Detect-Show {
    $first = $script:items | Select-Object -First 1
    if (-not $first) { return }
    $guess = Guess-Show $first.Name
    $cmbSerie.Items.Clear()
    $lib = @(Library-Shows)
    foreach ($s in $lib) { [void]$cmbSerie.Items.Add($s) }
    $script:tvId = 0; $lblTv.Text = ''
    $res = @(Tmdb-Search $guess)
    $match = $null
    foreach ($r in $res) {
        foreach ($libName in $lib) {
            if ((Norm $libName) -eq (Norm $r.name) -or (Norm $libName) -eq (Norm $r.original_name)) { $match = @{ Lib = $libName; Tv = $r.id }; break }
        }
        if ($match) { break }
    }
    if ($match) { $cmbSerie.Text = $match.Lib; $script:tvId = $match.Tv; Log "Serie reconhecida na biblioteca: $($match.Lib) (TMDB $($match.Tv))" }
    elseif ($res.Count -gt 0) { $cmbSerie.Text = $res[0].name; $script:tvId = $res[0].id; Log "Serie NOVA sugerida: $($res[0].name) (TMDB $($res[0].id)) - confira o nome" }
    else { $cmbSerie.Text = $guess; Log "Nao achei no TMDB - usando '$guess'" }
    if ($script:tvId) { $lblTv.Text = "TMDB $($script:tvId)" }
}

# ---------- analise ----------
function Raise($it, $lvl, $msg) {
    [void]$it.Notes.Add($msg)
    if ($RANK[$lvl] -gt $RANK[$it.Status]) { $it.Status = $lvl }
}
function Skip($it, $why) { $it.Action = 'skip'; $it.SkipReason = $why }
function Quality-Key($info) { return @{ Pt = [int]$info.HasPt; Px = $info.Pixels; Br = $info.Bitrate } }

function Get-Siblings($destDir) {
    if ($script:sibCache.ContainsKey($destDir)) { return $script:sibCache[$destDir] }
    $files = @()
    if (Test-Path -LiteralPath $destDir) {
        $files = @(Get-ChildItem -LiteralPath $destDir -File -EA 0 | Where-Object { $vext -contains $_.Extension.ToLower() })
    }
    $sizes = @($files | ForEach-Object { $_.Length })
    $probed = @()
    $pick = @($files | Select-Object -First 3)
    foreach ($f in $pick) { $p = Probe-File $f.FullName; if ($p) { $probed += $p }; Pump }
    $r = [pscustomobject]@{
        Files = $files; MedSize = (Median $sizes)
        MedPixels = (Median @($probed | ForEach-Object { $_.Pixels })); MedDur = (Median @($probed | ForEach-Object { $_.Dur }))
    }
    $script:sibCache[$destDir] = $r
    return $r
}

function Analyze-All($show) {
    if (-not (Test-Path -LiteralPath $HdRoot)) { Log "HD nao encontrado ($HdRoot). Conecte o HD para analisar/importar."; return }
    $script:sibCache = @{}
    Log "--- Analise: $show ---"
    if (-not $ffprobe) { Log 'AVISO: ffprobe nao encontrado - analise limitada.' }
    $n = 0
    foreach ($it in $script:items) {
        $it.Status = 'OK'; $it.Notes.Clear(); $it.Action = 'copy'; $it.SkipReason = ''; $it.Existing = @()
        $n++; Log "[$n/$($script:items.Count)] $($it.Name)"; Pump
        if ($it.Season -le 0 -or $it.Ep -le 0) { Raise $it 'BLOQUEIO' 'temporada/episodio nao detectado'; Skip $it 'sem S/E'; continue }
        $it.Info = Probe-File $it.Path
        if (-not $it.Info) { Raise $it 'BLOQUEIO' 'ffprobe nao conseguiu ler o arquivo (corrompido?)'; Skip $it 'ilegivel'; continue }
        $it.Dst = ''
        # integridade + compatibilidade com a TV (origem)
        $hard = $false
        if (Get-Command Get-CompatIssues -EA 0) {
            foreach ($i in @(Get-CompatIssues -File $it.Path -Ffprobe $ffprobe -Ffmpeg $ffmpeg)) {
                if ($i -match 'CORROMPIDO|TRUNCADO|sem faixa de video|duracao invalida|decodificacao falhou') { $hard = $true; Raise $it 'BLOQUEIO' $i }
                else { Raise $it 'ATENCAO' $i }
            }
        }
        # idioma
        $info = $it.Info
        if (-not $info.HasPt) {
            $langs = (@($info.Audio | ForEach-Object { $_.Lang } | Select-Object -Unique) -join ',')
            if (@($info.Audio | Where-Object { $_.Lang -eq 'und' }).Count -eq $info.Audio.Count -and $info.Audio.Count -gt 0) {
                Raise $it 'ATENCAO' 'idioma do audio nao identificado (und) - confirme se e dublado'
            } else {
                $ptsub = if (@($info.Subs | Where-Object { $_ -in @('por', 'pt', 'pob') }).Count) { ' (tem legenda PT)' } else { ' (sem legenda PT)' }
                Raise $it 'ATENCAO' "SEM audio PT-BR - idiomas: $langs$ptsub"
            }
        }
        if ($it.Size -lt 8MB) { Raise $it 'ATENCAO' 'arquivo muito pequeno' }

        # existente no HD
        $destDir = Get-DestDir $show $it.Season
        $it.Dst = Join-Path $destDir (('{0} S{1:D2}E{2:D2}' -f $show, $it.Season, $it.Ep) + [IO.Path]::GetExtension($it.Path).ToLower())
        $sib = Get-Siblings $destDir
        $it.Existing = @($sib.Files | Where-Object { Match-Ep $_.Name $it.Season $it.Ep })
        if ($hard) {
            if ($it.Existing.Count) { Skip $it 'origem com problema - mantida a copia atual do HD' } else { Skip $it 'origem com problema' }
            continue
        }
        if ($it.Existing.Count) {
            $best = $null; $bestInfo = $null; $broken = $true
            foreach ($ef in $it.Existing) {
                $ei = Probe-File $ef.FullName
                $bad = $false
                if (-not $ei) { $bad = $true }
                elseif (Get-Command Get-CompatIssues -EA 0) {
                    $bad = [bool](@(Get-CompatIssues -File $ef.FullName -Ffprobe $ffprobe -Ffmpeg $ffmpeg -SkipIntegrity) -match 'CORROMPIDO|TRUNCADO|sem faixa')
                }
                if (-not $bad) {
                    $broken = $false
                    if (-not $bestInfo -or $ei.HasPt -gt $bestInfo.HasPt -or ($ei.HasPt -eq $bestInfo.HasPt -and $ei.Pixels -gt $bestInfo.Pixels)) { $bestInfo = $ei; $best = $ef }
                }
            }
            if ($broken) { $it.Action = 'replace'; [void]$it.Notes.Add('versao do HD esta com problema - sera substituida') }
            elseif ($best.Length -eq $it.Size -and $best.FullName -eq $it.Dst) { Skip $it 'ja existe no HD (mesmo arquivo)' }
            elseif ($bestInfo.HasPt -and -not $info.HasPt) { Skip $it 'o HD ja tem versao PT-BR; esta nao tem' }
            elseif (-not $bestInfo.HasPt -and $info.HasPt) { $it.Action = 'replace'; [void]$it.Notes.Add('passa a ter audio PT-BR (a do HD nao tinha)') }
            elseif ($info.Pixels -lt $bestInfo.Pixels) { Skip $it ("qualidade menor que a do HD ({0} < {1})" -f (Res-Label $info.W $info.H), (Res-Label $bestInfo.W $bestInfo.H)) }
            elseif ($info.Pixels -gt $bestInfo.Pixels) { $it.Action = 'replace'; [void]$it.Notes.Add(("qualidade maior ({0} > {1}) - substitui a do HD" -f (Res-Label $info.W $info.H), (Res-Label $bestInfo.W $bestInfo.H))) }
            elseif ($info.Bitrate -gt ($bestInfo.Bitrate * 1.25)) { $it.Action = 'replace'; [void]$it.Notes.Add('mesmo tamanho de tela, bitrate bem maior - substitui') }
            else { Skip $it 'sem ganho sobre a versao do HD' }
            if ($it.Action -eq 'skip') { continue }
        }
        # comparacao com os irmaos
        $others = @($sib.Files | Where-Object { -not (Match-Ep $_.Name $it.Season $it.Ep) })
        if ($others.Count -ge 2) {
            if ($sib.MedSize -gt 0 -and $it.Size -lt ($sib.MedSize * 0.5)) {
                Raise $it 'ATENCAO' ("bem menor que os outros episodios: {0} vs mediana {1} (truncado ou qualidade menor?)" -f (MB $it.Size), (MB $sib.MedSize))
            }
            if ($sib.MedPixels -gt 0 -and $info.Pixels -gt 0 -and ($info.Pixels * 1.3) -lt $sib.MedPixels) {
                Raise $it 'ATENCAO' 'resolucao menor que a dos outros episodios da pasta'
            }
            if ($sib.MedDur -gt 0 -and $info.Dur -gt 0 -and ($info.Dur -lt ($sib.MedDur * 0.6) -or $info.Dur -gt ($sib.MedDur * 1.6))) {
                Raise $it 'ATENCAO' ("duracao {0:N0} min destoa dos outros ({1:N0} min)" -f ($info.Dur / 60), ($sib.MedDur / 60))
            }
        }
        $sea = Get-SeasonInfo $it.Season
        if ($sea) {
            $epd = $sea.episodes | Where-Object { $_.episode_number -eq $it.Ep } | Select-Object -First 1
            if ($epd -and $epd.runtime -gt 0 -and $info.Dur -gt 0 -and $info.Dur -lt ($epd.runtime * 60 * 0.6)) {
                Raise $it 'ATENCAO' ("duracao {0:N0} min, TMDB diz ~{1} min (incompleto?)" -f ($info.Dur / 60), $epd.runtime)
            }
        }
    }

    # duplicados dentro do lote (mesmo S/E): fica o melhor
    $groups = $script:items | Where-Object { $_.Action -ne 'skip' -and $_.Info } | Group-Object { '{0}-{1}' -f $_.Season, $_.Ep } | Where-Object { $_.Count -gt 1 }
    foreach ($g in $groups) {
        $ranked = @($g.Group | Sort-Object @{ e = { [int]$_.Info.HasPt }; Descending = $true }, @{ e = { $_.Info.Pixels }; Descending = $true }, @{ e = { $_.Info.Bitrate }; Descending = $true })
        for ($k = 1; $k -lt $ranked.Count; $k++) { Skip $ranked[$k] "duplicado no lote - fica $($ranked[0].Name)" }
    }

    # espaco livre
    $need = 0; foreach ($it in $script:items) { if ($it.Action -ne 'skip') { $need += $it.Size } }
    try {
        $drv = New-Object IO.DriveInfo ((Split-Path $HdRoot -Qualifier) + '\')
        $free = $drv.AvailableFreeSpace
        Log ("Espaco: precisa de {0:N1} GB, HD tem {1:N1} GB livres" -f ($need / 1GB), ($free / 1GB))
        if ($need + 2GB -gt $free) {
            foreach ($it in $script:items) { if ($it.Action -ne 'skip') { Raise $it 'BLOQUEIO' 'sem espaco livre suficiente no HD'; Skip $it 'sem espaco no HD' } }
        }
    } catch { Log "AVISO: nao consegui ler o espaco livre ($($_.Exception.Message))" }

    # episodios que faltam
    foreach ($sg in ($script:items | Where-Object { $_.Season -gt 0 } | Group-Object Season)) {
        $s = [int]$sg.Name
        $destDir = Get-DestDir $show $s
        $have = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($it in $sg.Group) { [void]$have.Add($it.Ep) }
        if (Test-Path -LiteralPath $destDir) {
            Get-ChildItem -LiteralPath $destDir -File -EA 0 | Where-Object { $vext -contains $_.Extension.ToLower() } | ForEach-Object {
                $pe = Parse-Ep $_.Name; if ($pe[0] -eq $s -and $pe[1] -gt 0) { [void]$have.Add($pe[1]) }
            }
        }
        $total = 0
        $sea = Get-SeasonInfo $s
        if ($sea -and $sea.episodes) { $total = @($sea.episodes).Count }
        if ($total -le 0) { $total = ($have | Measure-Object -Maximum).Maximum }
        $miss = @(1..$total | Where-Object { -not $have.Contains($_) })
        if ($miss.Count -gt 0 -and $miss.Count -le 40) {
            Log ("Temporada {0}: faltam {1} de {2}: {3}" -f $s, $miss.Count, $total, ((($miss | ForEach-Object { 'E{0:D2}' -f $_ }) -join ', ')))
        } elseif ($miss.Count -eq 0) { Log "Temporada ${s}: completa ($total eps)." }
    }

    if (-not $NoAI -and $aiName -and ($Headless -or $chkIA.Checked)) { Review-WithAI $show }
    foreach ($it in $script:items) {
        $lvl = if ($it.Action -eq 'skip') { 'PULAR' } else { $it.Status }
        $extra = if ($it.Action -eq 'skip') { $it.SkipReason } else { $it.Action }
        Log ("  S{0:D2}E{1:D2}  [{2}] {3}" -f $it.Season, $it.Ep, $lvl, $extra)
        foreach ($nt in $it.Notes) { Log "      - $nt" }
    }
    Refresh-List
}

# ---------- IA ----------
function Review-WithAI($show) {
    if ($aiName -eq 'Claude') { $model = Get-EnvValue 'ANTHROPIC_MODEL'; if (-not $model) { $model = 'claude-sonnet-5-5' } }
    else { $model = Get-EnvValue 'GEMINI_MODEL'; if (-not $model) { $model = 'gemini-flash-latest' } }
    $rows = @(foreach ($it in $script:items) {
        if (-not $it.Info) { continue }
        [ordered]@{
            ep = ('S{0:D2}E{1:D2}' -f $it.Season, $it.Ep); arquivo = $it.Name; tamanho_mb = [int]($it.Size / 1MB)
            resolucao = (Res-Label $it.Info.W $it.Info.H); codec_video = $it.Info.VCodec; duracao_min = [int]($it.Info.Dur / 60)
            bitrate_kbps = [int]($it.Info.Bitrate / 1000)
            audio = @($it.Info.Audio | ForEach-Object { "$($_.Lang)/$($_.Codec)/$($_.Ch)ch" }); legendas = @($it.Info.Subs | Select-Object -Unique)
            acao_planejada = $it.Action; motivo_pulo = $it.SkipReason; achados_automaticos = @($it.Notes)
            existente_no_hd = @($it.Existing | ForEach-Object { "$($_.Name) $([int]($_.Length / 1MB))MB" })
        }
    })
    if (-not $rows.Count) { return }
    $sibs = @()
    $dd = Get-DestDir $show ($script:items[0].Season)
    $sb = Get-Siblings $dd
    $ctx = [ordered]@{ serie = $show; pasta_destino_tem_arquivos = $sb.Files.Count; mediana_tamanho_mb = [int]($sb.MedSize / 1MB); mediana_duracao_min = [int]($sb.MedDur / 60) }
    $sys = 'Voce e o revisor tecnico de um importador de episodios para uma biblioteca de TV (Samsung Tizen, AVPlay). Criterios do dono: so quer episodios DUBLADOS em PT-BR (ou dual audio); prioridade e a qualidade (resolucao/bitrate); arquivo corrompido/truncado/incompleto nao serve; codecs que a TV nao toca (DTS, TrueHD, Xvid antigo, etc.) sao problema. Voce recebe metadados tecnicos (ffprobe) e achados automaticos. Aponte SO problemas reais que os achados automaticos nao cobriram ou que merecem destaque (ex.: duracao incompativel, bitrate anormalmente baixo para a resolucao, audio PT que pode ser so um canal/comentario, episodio duplo, mismatch de nome). Responda APENAS com JSON: {"resumo":"1 frase em pt-BR","itens":[{"ep":"S01E08","nivel":"OK|ATENCAO|BLOQUEAR","motivo":"curto, pt-BR"}]}. Se esta tudo certo, devolva todos como OK.'
    $user = (ConvertTo-Json -InputObject ([ordered]@{ contexto = $ctx; episodios = $rows }) -Depth 6 -Compress)
    Log "Revisando com IA ($aiName)..."; Pump
    try {
        if ($aiName -eq 'Claude') {
            $body = ConvertTo-Json -Depth 8 -InputObject ([ordered]@{ model = $model; max_tokens = 1500; system = $sys; messages = @(@{ role = 'user'; content = $user }) })
            $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/messages' -Method Post `
                -Headers @{ 'x-api-key' = $anthropicKey; 'anthropic-version' = '2023-06-01' } `
                -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
            $txt = (@($resp.content | Where-Object { $_.type -eq 'text' }) | Select-Object -First 1).text
        } else {
            $body = ConvertTo-Json -Depth 8 -InputObject ([ordered]@{
                systemInstruction = @{ parts = @(@{ text = $sys }) }
                contents = @(@{ role = 'user'; parts = @(@{ text = $user }) })
                generationConfig = @{ responseMimeType = 'application/json'; maxOutputTokens = 6000 }
            })
            $resp = Invoke-RestMethod -Uri "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent" -Method Post `
                -Headers @{ 'x-goog-api-key' = $geminiKey } `
                -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
            $txt = (@($resp.candidates[0].content.parts) | Select-Object -First 1).text
        }
        if ($txt -notmatch '(?s)\{.*\}') { Log 'IA: resposta sem JSON, ignorada.'; return }
        $r = $matches[0] | ConvertFrom-Json
        if ($r.resumo) { Log "IA: $($r.resumo)" }
        foreach ($ri in @($r.itens)) {
            if ($ri.nivel -notin @('ATENCAO', 'BLOQUEAR') -or -not $ri.motivo) { continue }
            $it = $script:items | Where-Object { ('S{0:D2}E{1:D2}' -f $_.Season, $_.Ep) -eq $ri.ep } | Select-Object -First 1
            if ($it) { Raise $it 'ATENCAO' ("IA ($($ri.nivel)): $($ri.motivo)") }
        }
    } catch { Log "IA indisponivel: $($_.Exception.Message)" }
}

# ---------- copia ----------
function Copy-Part($src, $part) {
    $total = (Get-Item -LiteralPath $src).Length
    $in = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
    try {
        $out = [IO.File]::Create($part)
        try {
            $buf = New-Object byte[] (4MB); $done = 0; $tick = 0
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n); $done += $n
                if ((++$tick) % 4 -eq 0) { $prog.Value = [int](1000 * $done / [Math]::Max(1, $total)); Pump }
            }
        } finally { $out.Close() }
    } finally { $in.Close() }
    return ((Get-Item -LiteralPath $part).Length -eq $total)
}

function Make-Thumb($dstPath, $season, $ep, $preferStill) {
    if (-not $ffmpeg) { return }
    $thumbs = Join-Path $HdRoot 'thumbs'
    New-Item -ItemType Directory -Force -Path $thumbs | Out-Null
    $out = Join-Path $thumbs ((Split-Path $dstPath -Leaf) + '.jpg')
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
    if ($preferStill) {
        $sea = Get-SeasonInfo $season
        $epd = $null; if ($sea) { $epd = $sea.episodes | Where-Object { $_.episode_number -eq $ep } | Select-Object -First 1 }
        if ($epd -and $epd.still_path) {
            $tmp = Join-Path $env:TEMP ('st_' + [guid]::NewGuid().ToString('N') + '.jpg')
            try {
                Invoke-WebRequest "https://image.tmdb.org/t/p/w780$($epd.still_path)" -OutFile $tmp -TimeoutSec 30
                & $ffmpeg -y -i $tmp -vf 'scale=854:480:force_original_aspect_ratio=increase,crop=854:480' -frames:v 1 -q:v 3 -- $out 2>$null
            } catch {}
            if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) }
        }
    }
    if (-not (Test-Path -LiteralPath $out)) {
        $dur = 600.0
        if ($ffprobe) {
            $d = & $ffprobe -v error -show_entries format=duration -of csv=p=0 -- $dstPath 2>$null
            $x = 0.0
            if ($d -and [double]::TryParse(($d -replace ',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$x) -and $x -gt 0) { $dur = $x }
        }
        $ss = [Math]::Max(30, [Math]::Min($dur * 0.15, 420))
        & $ffmpeg -y -ss $ss -i $dstPath -frames:v 1 -vf 'scale=480:-2' -q:v 3 -- $out 2>$null
        if (-not (Test-Path -LiteralPath $out)) { & $ffmpeg -y -ss 5 -i $dstPath -frames:v 1 -vf 'scale=480:-2' -q:v 3 -- $out 2>$null }
    }
    if (Test-Path -LiteralPath $out) { Log '    miniatura OK' } else { Log '    miniatura falhou' }
}

function Make-SeriesCover($show) {
    if ($script:tvId -le 0 -or -not $tmdbKey -or -not $ffmpeg) { return }
    $out = Join-Path (Join-Path $HdRoot 'thumbs') "$show.jpg"
    if (Test-Path -LiteralPath $out) { return }
    try {
        $tv = Invoke-RestMethod ('https://api.themoviedb.org/3/tv/{0}?api_key={1}&language=pt-BR' -f $script:tvId, $tmdbKey) -TimeoutSec 20
        if (-not $tv.poster_path) { return }
        $fc = '[0:v]scale=854:480:force_original_aspect_ratio=increase,crop=854:480,boxblur=24:4,eq=brightness=-0.14[bg];[0:v]scale=-1:480[fg];[bg][fg]overlay=(W-w)/2:0'
        $tmp = Join-Path $env:TEMP ('pp_' + [guid]::NewGuid().ToString('N') + '.jpg')
        Invoke-WebRequest "https://image.tmdb.org/t/p/w500$($tv.poster_path)" -OutFile $tmp -TimeoutSec 30
        New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
        & $ffmpeg -y -i $tmp -filter_complex $fc -frames:v 1 -q:v 3 -- $out 2>$null
        [IO.File]::Delete($tmp)
        Log '  capa da serie criada'
    } catch { Log "  capa da serie falhou: $($_.Exception.Message)" }
}

function Do-Import {
    if ($script:busy) { return }
    $show = Get-ShowText
    if (-not $show) { [void][Windows.Forms.MessageBox]::Show('Informe a serie.'); return }
    if (-not (Test-Path -LiteralPath $HdRoot)) {
        if ($Headless) { Log "HD nao encontrado ($HdRoot)" } else { [void][Windows.Forms.MessageBox]::Show("HD nao encontrado ($HdRoot). Conecte o HD.") }
        return
    }
    $script:busy = $true
    if (-not $Headless) { $btnImp.Enabled = $false; $btnAn.Enabled = $false }
    try {
        Analyze-All $show
        $flagged = @($script:items | Where-Object { $_.Action -ne 'skip' -and $_.Status -ne 'OK' })
        $todo = @($script:items | Where-Object { $_.Action -ne 'skip' -and $_.Status -ne 'BLOQUEIO' })
        if (-not $todo.Count) { Log 'Nada a importar.'; return }
        if ($flagged.Count) {
            $msg = "$($flagged.Count) arquivo(s) com alerta:`r`n`r`n" + ((@($flagged | Select-Object -First 10) | ForEach-Object { 'S{0:D2}E{1:D2}: {2}' -f $_.Season, $_.Ep, ($_.Notes -join ' | ') }) -join "`r`n") + "`r`n`r`nImportar mesmo assim?"
            if (-not (Ask-Yes $msg 'Alertas na analise')) { Log 'Cancelado pelo usuario.'; return }
        }
        $flat = Is-Flat $show
        Log "== Importando: $show  ($(if ($flat) {'pasta unica'} else {'por temporada'})) =="
        $ok = 0; $fail = 0; $newSeason = @{}
        foreach ($it in $todo) {
            $destDir = Split-Path $it.Dst -Parent
            if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null; if (-not $flat) { $newSeason[$it.Season] = $true } }
            $label = '{0} S{1:D2}E{2:D2}' -f $show, $it.Season, $it.Ep
            Log "  $label : $($it.Action) ($(MB $it.Size))..."
            $part = $it.Dst + '.part'
            if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
            if (-not (Copy-Part $it.Path $part)) { Log '    FALHOU (tamanho nao bateu)'; if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }; $fail++; continue }
            $prog.Value = 0
            # confere a copia ANTES de tirar a versao antiga do lugar
            if (Get-Command Get-CompatIssues -EA 0) {
                $bad = @(Get-CompatIssues -File $part -Ffprobe $ffprobe -Ffmpeg $ffmpeg) -match 'CORROMPIDO|TRUNCADO|sem faixa|decodificacao falhou|duracao invalida'
                if ($bad) { Log "    copia com problema ($($bad -join '; ')) - descartada, HD intacto"; Remove-Item -LiteralPath $part -Force; $fail++; continue }
            }
            foreach ($old in $it.Existing) {
                if ($old.FullName -ne $it.Dst) {
                    Remove-Item -LiteralPath $old.FullName -Force
                    $ot = Join-Path (Join-Path $HdRoot 'thumbs') ($old.Name + '.jpg')
                    if (Test-Path -LiteralPath $ot) { Remove-Item -LiteralPath $ot -Force }
                    Log "    removida versao anterior: $($old.Name)"
                }
            }
            Move-Item -LiteralPath $part -Destination $it.Dst -Force
            $ok++
            # legendas externas ao lado do video de origem
            $srcBase = [IO.Path]::GetFileNameWithoutExtension($it.Path)
            Get-ChildItem -LiteralPath (Split-Path $it.Path) -File -EA 0 | Where-Object {
                $sext -contains $_.Extension.ToLower() -and $_.BaseName.StartsWith($srcBase) -and $_.Length -ge 200
            } | ForEach-Object {
                $subDir = Join-Path $HdRoot 'subs'; New-Item -ItemType Directory -Force -Path $subDir | Out-Null
                $suf = $_.BaseName.Substring($srcBase.Length)
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $subDir ((Split-Path $it.Dst -Leaf) + $suf + $_.Extension)) -Force
                Log "    legenda: $($_.Name)"
            }
            Make-Thumb $it.Dst $it.Season $it.Ep (-not $flat)
        }
        Log "Concluido: $ok importado(s), $fail falha(s), $(@($script:items | Where-Object { $_.Action -eq 'skip' }).Count) pulado(s)."
        if (-not $flat) {
            Make-SeriesCover $show
            $capas = Join-Path $PSScriptRoot 'capas-temporada.ps1'
            if ($newSeason.Count -and $tmdbKey -and (Test-Path -LiteralPath $capas)) {
                Log 'Gerando capa da temporada...'
                try { & $capas -ApiKey $tmdbKey -Root $HdRoot -Only $show *>&1 | ForEach-Object { Log "    $_" } } catch { Log "  capa da temporada falhou: $($_.Exception.Message)" }
            }
        }
    } finally {
        $prog.Value = 0
        $script:busy = $false
        if (-not $Headless) { Refresh-List }
    }
}

# ---------- eventos ----------
if (-not $Headless) {
    $dragEnter = { if ($_.Data.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)) { $_.Effect = 'Copy' } }
    $dragDrop  = { Add-Paths ($_.Data.GetData([Windows.Forms.DataFormats]::FileDrop)) }
    $form.Add_DragEnter($dragEnter); $form.Add_DragDrop($dragDrop)
    $lblDrop.Add_DragEnter($dragEnter); $lblDrop.Add_DragDrop($dragDrop)

    $btnPasta.Add_Click({
        $fd = New-Object Windows.Forms.FolderBrowserDialog; $fd.SelectedPath = $DefaultDl
        if ($fd.ShowDialog() -eq 'OK') { Add-Paths @($fd.SelectedPath) }
    })
    $btnArq.Add_Click({
        $fd = New-Object Windows.Forms.OpenFileDialog; $fd.Multiselect = $true; $fd.InitialDirectory = $DefaultDl
        $fd.Filter = 'Videos|*.mkv;*.mp4;*.avi;*.m4v;*.ts|Todos|*.*'
        if ($fd.ShowDialog() -eq 'OK') { Add-Paths $fd.FileNames }
    })
    $btnLimpa.Add_Click({ $script:items.Clear(); Refresh-List; $cmbSerie.Text = ''; $lblTv.Text = ''; $script:tvId = 0; $script:seasonCache = @{} })
    $btnBusca.Add_Click({
        $r = @(Tmdb-Search $cmbSerie.Text)
        if ($r.Count) { $cmbSerie.Text = $r[0].name; $script:tvId = $r[0].id; $script:seasonCache = @{}; $lblTv.Text = "TMDB $($r[0].id)"; Log "TMDB: $($r[0].name) ($($r[0].first_air_date))" }
        else { Log 'Nada encontrado no TMDB.' }
    })
    $btnAn.Add_Click({
        if ($script:busy) { return }
        $s = Get-ShowText; if (-not $s) { [void][Windows.Forms.MessageBox]::Show('Informe a serie.'); return }
        $script:busy = $true; $btnAn.Enabled = $false; $btnImp.Enabled = $false
        try { Analyze-All $s } finally { $script:busy = $false; Refresh-List }
    })
    $btnImp.Add_Click({ Do-Import })
    $lv.Add_KeyDown({
        if ($_.KeyCode -eq 'Delete') {
            foreach ($i in @($lv.SelectedIndices | Sort-Object -Descending)) { $script:items.RemoveAt($i) }
            Refresh-List
        }
    })

    foreach ($s in (Library-Shows)) { [void]$cmbSerie.Items.Add($s) }
    if (-not (Test-Path -LiteralPath $HdRoot)) { Log "AVISO: HD ($HdRoot) nao esta conectado." }
    if ($aiName) { Log "IA habilitada: $aiName (chave encontrada no .env)." }
    [void]$form.ShowDialog()
} else {
    $script:tvId = $TvId
    Add-Paths $Paths
    Do-Import
}
