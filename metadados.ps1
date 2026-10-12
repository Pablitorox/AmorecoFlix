<#
  metadados.ps1 - sinopse, ano, generos, titulos de episodio e artes 16:9 do
  TMDB para as telas novas do app (Inicio, pagina da serie, Biblioteca).

  Saida no HD:
    <Root>\meta\biblioteca.json
    <Root>\meta\fundos\<pasta ou arquivo>.jpg   fundo 16:9 (TMDB w1280)
    <Root>\meta\posters\<arquivo do filme>.jpg  poster 2:3 (w342) dos filmes soltos
    <Root>\meta\ids.json   (opcional, voce cria) correcao quando o TMDB erra:
                           { "Animes/Death Parade": 62715, "Filmes/X (2020).mkv": 1234 }
                           (serie/anime = id de TV; filme = id de filme; colecao = id de colecao)

  A chave de cada titulo e o caminho relativo a biblioteca, igual ao
  progresso.json: "Series/The Vampire Diaries", "Filmes/Anaconda (2025).mkv".
  Cada serie tem "arquivos": { "<nome do arquivo>": [temporada, episodio] } -
  o app usa isso para numerar episodios cujo nome nao diz (ex.: "02 O Comeco
  de Tudo.mp4").

  Incremental: o mapa de arquivos e refeito sempre (sem consultar o TMDB);
  busca so titulos/temporadas que ainda nao estao no json.

  Uso:
    .\metadados.ps1                       # so o que falta
    .\metadados.ps1 -Only "Death Parade"  # refaz um titulo (nome da pasta/arquivo ou chave)
    .\metadados.ps1 -Force                # refaz tudo (inclusive as imagens)
#>
param(
    [string]$ApiKey,
    [string]$Root = 'E:\AmorecoFlix',
    [string]$Only,
    [switch]$Force
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
if (-not (Test-Path -LiteralPath $Root)) { Write-Error "Biblioteca nao encontrada: $Root"; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$VideoExt   = @('.mp4','.mkv','.avi','.mov','.m4v','.ts','.webm','.wmv','.mpg','.mpeg','.m2ts')
$MetaDir    = Join-Path $Root 'meta'
$FundosDir  = Join-Path $MetaDir 'fundos'
$PostersDir = Join-Path $MetaDir 'posters'
$JsonPath   = Join-Path $MetaDir 'biblioteca.json'
New-Item -ItemType Directory -Force -Path $FundosDir, $PostersDir | Out-Null

function Read-JsonFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $null }
}
# PSCustomObject (do ConvertFrom-Json) -> hashtable ordenada (1 nivel)
function To-Hash($obj) {
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    $h = [ordered]@{}
    if ($obj) { foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value } }
    return $h
}
# propaganda de site de torrent fica de fora (mesma regra do isJunkVideo do app).
# Acentos so como \uXXXX: o PowerShell 5.1 le este arquivo (sem BOM) como ANSI,
# e o intervalo de letras acentuadas escrito direto virava um intervalo invalido
# (Is-Video recusava TODO video e os filmes sumiam do biblioteca.json).
$JunkVideo = '(^|[^a-z0-9\u00c0-\u00ff])(promo|1xbet|comando\.to|comandotorrents?|torrentdosfilmes|bludv|lapumia|hipnos|douglasvip|thepiratefilmes|amostras?|samples?|trailer|propaganda)(?![a-z0-9\u00c0-\u00ff])'
function Is-Junk($name) {
    $b = [IO.Path]::GetFileNameWithoutExtension($name)
    if ($b -notmatch $JunkVideo) { return $false }
    return ($b -notmatch '[sS]\d{1,2}[\s._-]*[eE]\d{1,3}|\b\d{1,2}x\d{1,3}\b|epis[o\u00f3]dio\s*\d')
}
function Is-Video($f) { ($VideoExt -contains $f.Extension.ToLower()) -and $f.Length -ge 8MB -and -not (Is-Junk $f.Name) }
function Year-Of($date) { if ("$date" -match '^(\d{4})') { return [int]$matches[1] } return $null }
function Genres-Of($obj) { @($obj.genres | ForEach-Object { $_.name }) }
function Safe-Name($s) { ($s -replace '[\\/:*?"<>|]', '_') }

# ---- estado anterior + correcoes manuais ----
$old = Read-JsonFile $JsonPath
$titulos = [ordered]@{}
if ($old -and $old.titulos -and (-not $Force -or $Only)) {     # -Force -Only refaz so aquele titulo
    foreach ($p in $old.titulos.PSObject.Properties) { $titulos[$p.Name] = $p.Value }
}
$ids = To-Hash (Read-JsonFile (Join-Path $MetaDir 'ids.json'))

function Save-Json {
    $doc = [ordered]@{ versao = 1; gerado = (Get-Date -Format s); titulos = $titulos }
    $json = $doc | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($JsonPath, $json, (New-Object Text.UTF8Encoding $false))
}

function Fetch-Image($path, $size, $dir, $name) {
    if (-not $path) { return $null }
    $file = (Safe-Name $name) + '.jpg'
    $out = Join-Path $dir $file
    if ((Test-Path -LiteralPath $out) -and -not $Force) { return $file }
    if (Save-TmdbImage $path $size $out) { return $file }
    return $null
}

# ---- titulos no HD ----
$items = @()
foreach ($cat in 'Series', 'Animes') {
    $catDir = Join-Path $Root $cat
    if (-not (Test-Path -LiteralPath $catDir)) { continue }
    foreach ($d in Get-ChildItem -LiteralPath $catDir -Directory) {
        $kind = 'serie'; if ($cat -eq 'Animes') { $kind = 'anime' }
        $items += [pscustomobject]@{ Key = "$cat/$($d.Name)"; Kind = $kind; Path = $d.FullName; Name = $d.Name }
    }
}
$filmesDir = Join-Path $Root 'Filmes'
if (Test-Path -LiteralPath $filmesDir) {
    foreach ($e in Get-ChildItem -LiteralPath $filmesDir) {
        if ($e.PSIsContainer) {
            $items += [pscustomobject]@{ Key = "Filmes/$($e.Name)"; Kind = 'colecao'; Path = $e.FullName; Name = $e.Name }
        } elseif (Is-Video $e) {
            $items += [pscustomobject]@{ Key = "Filmes/$($e.Name)"; Kind = 'filme'; Path = $e.FullName; Name = $e.Name }
        }
    }
}

# titulo que saiu do HD sai do json (exceto com -Only, que mexe so num)
if (-not $Only) {
    $keys = @($items | ForEach-Object { $_.Key })
    foreach ($k in @($titulos.Keys)) { if ($keys -notcontains $k) { $titulos.Remove($k); Write-Host "  - removido: $k" } }
}

function Wanted($it) {
    if (-not $Only) { return $true }
    return ($it.Key -like "*$Only*") -or ($it.Name -like "*$Only*")
}

# ---------------- serie / anime ----------------
function Build-Series($it) {
    $prev = $titulos[$it.Key]
    $e = [ordered]@{}
    if ($prev -and -not $Force) { $e = To-Hash $prev }
    $e.tipo = $it.Kind

    # arquivos -> [temporada, episodio] (sempre refeito: episodios novos entram)
    $arquivos = [ordered]@{}
    $dirs = @(Get-ChildItem -LiteralPath $it.Path -Directory | Where-Object { Get-FolderSeason $_.Name })
    $sources = @(@{ Dir = $it.Path; Season = 0 })
    foreach ($d in $dirs) { $sources += @{ Dir = $d.FullName; Season = (Get-FolderSeason $d.Name) } }
    foreach ($src in $sources) {
        foreach ($f in Get-ChildItem -LiteralPath $src.Dir -File | Where-Object { Is-Video $_ }) {
            $se = Get-SeasonEpisode $f.Name $src.Season
            if ($se) { $arquivos[$f.Name] = @($se.S, $se.E) }
        }
    }
    $e.arquivos = $arquivos

    # serie no TMDB
    $id = $ids[$it.Key]
    if (-not $id -and $e.tmdb) { $id = $e.tmdb }
    if (-not $id) { $hit = Find-TmdbTv $it.Name; if ($hit) { $id = $hit.id } }
    if (-not $id) { Write-Host ("  ? {0}" -f $it.Key) -ForegroundColor Yellow; $script:miss += $it.Key; return $e }

    if ($Force -or -not $e.titulo -or -not $e.fundo -or $e.tmdb -ne $id) {
        $tv = Invoke-Tmdb "/tv/$id"
        if (-not $tv) { Write-Host ("  ! falha lendo /tv/{0}" -f $id) -ForegroundColor Red; return $e }
        $sin = "$($tv.overview)"
        if (-not $sin) { $en = Invoke-Tmdb "/tv/$id" '' 'en-US'; if ($en) { $sin = "$($en.overview)" } }
        $e.tmdb = [int]$id
        $e.titulo = "$($tv.name)"
        $e.original = "$($tv.original_name)"
        $e.ano = Year-Of $tv.first_air_date
        $e.generos = Genres-Of $tv
        $e.sinopse = $sin
        $e.nota = [Math]::Round([double]$tv.vote_average, 1)
        $e.idioma = "$($tv.original_language)"
        $e.temporadasTmdb = [int]$tv.number_of_seasons
        $e.fundo = Fetch-Image $tv.backdrop_path 'w1280' $FundosDir $it.Name
        $e.temporadas = [ordered]@{}
    }

    # temporadas que existem no HD e ainda nao foram buscadas
    $temps = To-Hash $e.temporadas
    $need = @($arquivos.Values | ForEach-Object { $_[0] } | Sort-Object -Unique)
    foreach ($s in $need) {
        if ($temps.Contains("$s")) { continue }
        $sea = Invoke-Tmdb "/tv/$id/season/$s"
        if (-not $sea) { Write-Host ("    temporada {0}: nao achei no TMDB" -f $s) -ForegroundColor Yellow; continue }
        $eps = [ordered]@{}
        $generic = 0
        foreach ($ep in $sea.episodes) {
            $nm = "$($ep.name)"
            if (-not $nm -or $nm -match '^(Epis\u00f3dio|Episode)\s*\d+$') { $generic++ }
            $eps["$($ep.episode_number)"] = [ordered]@{ titulo = $nm; sinopse = "$($ep.overview)"; min = $ep.runtime }
        }
        # sem traducao em pt-BR ("Episodio 7"): usa o titulo em ingles
        if ($generic -gt 0) {
            $seaEn = Invoke-Tmdb "/tv/$id/season/$s" '' 'en-US'
            foreach ($ep in $seaEn.episodes) {
                $k = "$($ep.episode_number)"
                if ($eps.Contains($k) -and ($eps[$k].titulo -match '^(Epis\u00f3dio|Episode)\s*\d+$' -or -not $eps[$k].titulo) -and
                    $ep.name -and "$($ep.name)" -notmatch '^Episode\s*\d+$') {
                    $eps[$k].titulo = "$($ep.name)"
                    if (-not $eps[$k].sinopse) { $eps[$k].sinopse = "$($ep.overview)" }
                }
            }
        }
        $temps["$s"] = [ordered]@{ nome = "$($sea.name)"; episodios = $eps }
        Write-Host ("    temporada {0}: {1} episodios" -f $s, $eps.Count)
        Start-Sleep -Milliseconds 120
    }
    $e.temporadas = $temps

    # episodio no HD sem titulo no TMDB
    foreach ($a in $arquivos.Values) {
        $t = $temps["$($a[0])"]
        $ok = $false
        if ($t) { $eps = To-Hash $t.episodios; $ok = $eps.Contains("$($a[1])") }
        if (-not $ok) { $script:semTitulo++ }
    }
    Write-Host ("  OK {0}  ->  {1} ({2})" -f $it.Key, $e.titulo, $e.ano)
    return $e
}

# ---------------- filme ----------------
function Movie-Entry($id, $fileName, $withImages) {
    $m = Invoke-Tmdb "/movie/$id"
    if (-not $m) { return $null }
    $sin = "$($m.overview)"
    if (-not $sin) { $en = Invoke-Tmdb "/movie/$id" '' 'en-US'; if ($en) { $sin = "$($en.overview)" } }
    $e = [ordered]@{
        tipo = 'filme'; tmdb = [int]$id; titulo = "$($m.title)"; original = "$($m.original_title)"
        ano = Year-Of $m.release_date; min = $m.runtime; generos = Genres-Of $m; sinopse = $sin
        nota = [Math]::Round([double]$m.vote_average, 1); idioma = "$($m.original_language)"
    }
    if ($withImages) {
        $base = [IO.Path]::GetFileName($fileName)
        $e.fundo  = Fetch-Image $m.backdrop_path 'w1280' $FundosDir $base
        $e.poster = Fetch-Image $m.poster_path 'w342' $PostersDir $base
    }
    return $e
}

function Build-Movie($it) {
    $prev = $titulos[$it.Key]
    if ($prev -and $prev.titulo -and $prev.fundo -and -not $Force -and -not $Only) { return $prev }
    $id = $ids[$it.Key]
    if (-not $id -and $prev -and $prev.tmdb) { $id = $prev.tmdb }
    if (-not $id) { $hit = Find-TmdbMovie $it.Name; if ($hit) { $id = $hit.id } }
    if (-not $id) { Write-Host ("  ? {0}" -f $it.Key) -ForegroundColor Yellow; $script:miss += $it.Key; return [ordered]@{ tipo = 'filme' } }
    $e = Movie-Entry $id $it.Name $true
    if (-not $e) { return [ordered]@{ tipo = 'filme' } }
    Write-Host ("  OK {0}  ->  {1} ({2})" -f $it.Key, $e.titulo, $e.ano)
    return $e
}

# ---------------- colecao (pasta em Filmes) ----------------
function Build-Collection($it) {
    $prev = $titulos[$it.Key]
    $e = [ordered]@{}
    if ($prev -and -not $Force) { $e = To-Hash $prev }
    $e.tipo = 'colecao'

    $id = $ids[$it.Key]
    if (-not $id -and $e.tmdb) { $id = $e.tmdb }
    if (-not $id) { $hit = Find-TmdbCollection $it.Name; if ($hit) { $id = $hit.id } }
    if ($id -and ($Force -or -not $e.titulo -or -not $e.fundo)) {
        $c = Invoke-Tmdb "/collection/$id"
        if ($c) {
            $e.tmdb = [int]$id
            $e.titulo = ("$($c.name)" -replace '\s*[-:\u2013]?\s*(Cole\u00e7\u00e3o|Collection)\s*$', '' `
                                      -replace '^\s*(Cole\u00e7\u00e3o|Collection)\s*[-:\u2013]?\s*', '').Trim()
            $e.sinopse = "$($c.overview)"
            $e.fundo = Fetch-Image $c.backdrop_path 'w1280' $FundosDir $it.Name
        }
    }
    if (-not $e.titulo) { $e.titulo = $it.Name }

    # cada filme da pasta (titulo, ano, duracao, sinopse)
    $filmes = To-Hash $e.filmes
    $vids = @(Get-ChildItem -LiteralPath $it.Path -File -Recurse | Where-Object { Is-Video $_ })
    $names = @($vids | ForEach-Object { $_.Name })
    foreach ($k in @($filmes.Keys)) { if ($names -notcontains $k) { $filmes.Remove($k) } }
    foreach ($v in $vids) {
        if ($filmes.Contains($v.Name) -and -not $Force) { continue }
        $hit = Find-TmdbMovie $v.Name
        if (-not $hit) { Write-Host ("    ? {0}" -f $v.Name) -ForegroundColor Yellow; continue }
        $m = Movie-Entry $hit.id $v.Name $false
        if ($m) { $m.Remove('tipo'); $filmes[$v.Name] = $m }
        Start-Sleep -Milliseconds 120
    }
    $e.filmes = $filmes
    if (-not $e.ano) {
        $anos = @($filmes.Values | Where-Object { $_.ano } | ForEach-Object { $_.ano } | Sort-Object)
        if ($anos.Count) { $e.ano = $anos[0] }
    }
    if (-not $e.sinopse) { $first = @($filmes.Values | Where-Object { $_.sinopse })[0]; if ($first) { $e.sinopse = $first.sinopse } }
    Write-Host ("  OK {0}  ->  {1} ({2} filmes)" -f $it.Key, $e.titulo, $filmes.Count)
    return $e
}

# ---------------- roda ----------------
$script:miss = @()
$script:semTitulo = 0
$n = 0
foreach ($it in $items) {
    if (-not (Wanted $it)) { continue }
    $n++
    if ($it.Kind -eq 'filme')       { $titulos[$it.Key] = Build-Movie $it }
    elseif ($it.Kind -eq 'colecao') { $titulos[$it.Key] = Build-Collection $it }
    else                            { $titulos[$it.Key] = Build-Series $it }
    Save-Json                                   # parcial: nao perde o que ja veio
    Start-Sleep -Milliseconds 150
}
Save-Json

Write-Host ""
Write-Host ("biblioteca.json: {0} titulos ({1} processados agora)" -f $titulos.Count, $n) -ForegroundColor Green
if ($script:miss.Count) {
    Write-Host ("sem match no TMDB ({0}) - corrija em meta\ids.json:" -f $script:miss.Count) -ForegroundColor Yellow
    $script:miss | ForEach-Object { Write-Host "  $_" }
}
if ($script:semTitulo) { Write-Host ("episodios sem titulo no TMDB: {0}" -f $script:semTitulo) -ForegroundColor Yellow }
