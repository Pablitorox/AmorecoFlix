<#
  limpar-lixo.ps1 - remove da biblioteca arquivos que NAO sao episodio/filme,
  legenda ou thumb: .url/.txt/.nfo de release, promos (1xbet...), logos de site,
  imagens de 0 byte, pastas "Creditos"/"Amostra".

  Preserva: video (.mkv/.mp4/.avi/...), legenda (.srt/.ass/.vtt/.sub/.idx),
  imagens de capa reais, tudo dentro de \thumbs, skip.json e *.json.

  Uso:  .\limpar-lixo.ps1            lista o que seria apagado (nao apaga)
        .\limpar-lixo.ps1 -Apply    apaga de verdade
#>
param([string]$Root = 'E:\AmorecoFlix', [switch]$Apply)
$ErrorActionPreference = 'Continue'

$JUNK_EXT  = @('.url','.txt','.nfo','.exe','.lnk','.htm','.html','.website','.md5','.sfv','.diz')
# palavras inteiras (\b): sem isso "hipnos" pegava o filme "Hipnose" e "leia" qualquer nome com "Leia"
$JUNK_NAME = '\b(promo\w*|1xbet|comando\.to|torrentdosfilmes|bludv|lapumia|hipnos|douglasvip|by-luanharper|thepiratefilmes|semear|mais\s*lan|leia[\s._-]*me|amostras?|samples?|screens?|divx|rarbg)\b'
$KEEP_EXT  = @('.mkv','.mp4','.avi','.m4v','.ts','.mov','.wmv','.srt','.ass','.ssa','.vtt','.sub','.idx','.json')
$VIDEO_EXT = @('.mkv','.mp4','.avi','.m4v','.ts','.mov','.wmv')

$thumbsDir = (Join-Path $Root 'thumbs').ToLower()
$targets = New-Object System.Collections.ArrayList

# pasta com video de verdade (>= 40 MB) dentro nunca e apagada, mesmo que o nome bata
function Has-RealVideo($dir) {
    [bool](Get-ChildItem -LiteralPath $dir -Recurse -File -Force -EA 0 |
           Where-Object { $VIDEO_EXT -contains $_.Extension.ToLower() -and $_.Length -ge 40MB } |
           Select-Object -First 1)
}

Get-ChildItem -LiteralPath $Root -Recurse -Force -EA 0 | ForEach-Object {
    $f = $_
    if ($f.PSIsContainer) {
        # [eé] = "e" ou "e com acento" (ASCII no fonte: o PowerShell 5.1 le .ps1 sem BOM como ANSI)
        if ($f.Name -match '^(cr[eé]ditos|amostra|sample|screens?|extras?)\b' -or $f.Name -match $JUNK_NAME) {
            if (Has-RealVideo $f.FullName) {
                Write-Host "  (mantida, tem video) $($f.FullName.Replace($Root, ''))" -ForegroundColor DarkGray
            } else {
                [void]$targets.Add($f)
            }
        }
        return
    }
    if ($f.FullName.ToLower().StartsWith($thumbsDir)) { return }         # nunca mexe em /thumbs
    $ext = $f.Extension.ToLower()

    if ($JUNK_EXT -contains $ext)                                   { [void]$targets.Add($f); return }
    if ($KEEP_EXT -contains $ext -and $ext -ne '.mp4' -and $ext -ne '.mkv' -and $ext -ne '.avi') { return }
    # video muito pequeno com cara de propaganda
    if (($ext -eq '.mp4' -or $ext -eq '.mkv' -or $ext -eq '.avi') -and $f.Length -lt 40MB -and $f.BaseName -match $JUNK_NAME) {
        [void]$targets.Add($f); return
    }
    # imagem de 0 byte ou logo de site
    if ($ext -match '^\.(jpe?g|png|webp|gif|bmp)$') {
        if ($f.Length -lt 1KB -or $f.BaseName -match $JUNK_NAME) { [void]$targets.Add($f); return }
    }
}

if ($targets.Count -eq 0) { Write-Host 'Nada de lixo encontrado.' -ForegroundColor Green; return }

Write-Host "$($targets.Count) itens:" -ForegroundColor Cyan
$targets | ForEach-Object {
    $tag = if ($_.PSIsContainer) { '[dir]' } else { '{0,7:N1} KB' -f ($_.Length / 1KB) }
    Write-Host ("  {0}  {1}" -f $tag, $_.FullName.Replace($Root, ''))
}

if (-not $Apply) { Write-Host "`n(simulacao - rode com -Apply para apagar)" -ForegroundColor Yellow; return }

$n = 0
$targets | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    try {
        if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $true) }
        else { [IO.File]::Delete($_.FullName) }
        $n++
    } catch { Write-Host "  falhou: $($_.Exception.Message)" -ForegroundColor Red }
}
Write-Host "`n$n itens apagados." -ForegroundColor Green
