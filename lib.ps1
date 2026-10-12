<#
  lib.ps1 - funcoes comuns dos scripts do PC (dot-source logo apos o param()):
    . (Join-Path $PSScriptRoot 'lib.ps1')

  Get-EnvValue NOME   -> variavel de ambiente, senao a linha NOME=... do .env do projeto
  Get-TmdbApiKey      -> chave TMDB ($env:TMDB_API_KEY ou .env)
  Find-FfTool nome    -> caminho do ffmpeg/ffprobe (PATH ou instalacao do winget Gyan.FFmpeg)

  TMDB (usam a variavel $ApiKey do script que chamou):
  Invoke-Tmdb '/tv/123' ['&extra=1']   -> resposta em pt-BR (3 tentativas) ou $null
  Find-TmdbTv 'Nome da pasta'          -> resultado de /search/tv (serie/anime) ou $null
  Find-TmdbMovie 'arquivo.mkv'         -> resultado de /search/movie pelo titulo+ano do nome
  Find-TmdbCollection 'Pasta'          -> resultado de /search/collection ou $null
  Get-SeasonEpisode 'arquivo' 'pasta'  -> @{ S=n; E=n } (S01E02, 1x02, Episodio 2, "02 Titulo")
  Save-TmdbImage '/caminho.jpg' 'w1280' 'C:\saida.jpg'

  Uso tipico da chave (com -ApiKey NAO mandatorio):
    if (-not $ApiKey) { $ApiKey = Get-TmdbApiKey }
    if (-not $ApiKey) { Write-Error "Informe -ApiKey ou crie .env com TMDB_API_KEY=..."; exit 1 }
#>

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

function Get-TmdbApiKey { return (Get-EnvValue 'TMDB_API_KEY') }

$script:FfToolCache = @{}
function Find-FfTool([string]$name) {
    if ($script:FfToolCache.ContainsKey($name)) { return $script:FfToolCache[$name] }
    $p = (Get-Command $name -EA 0).Source
    if (-not $p) {
        $b = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter "$name.exe" -EA 0 | Select-Object -First 1
        if ($b) { $p = $b.FullName }
    }
    $script:FfToolCache[$name] = $p
    return $p
}


# ============================== TMDB ==============================
# Buscas que ja funcionavam em posters-pastas.ps1 / posters-filmes.ps1,
# reunidas aqui para o metadados.ps1 (e para quem mais precisar).

# abreviacoes de pasta -> nome para a busca
$script:TmdbAlias = @{
    'fma brotherhood' = 'Fullmetal Alchemist Brotherhood'
    'fma'             = 'Fullmetal Alchemist'
    'hxh'             = 'Hunter x Hunter'
    'aot'             = 'Attack on Titan'
    'snk'             = 'Attack on Titan'
    'percy jackson 2' = 'Percy Jackson and the Olympians'
}
# pasta de FRANQUIA em Filmes -> nome(s) da colecao no TMDB
$script:TmdbCollectionAlias = @{
    'jurassic park'     = @('Jurassic World', 'Jurassic Park')
    'o bicho vai pegar' = @('Open Season', 'O Bicho Vai Pegar')
    'vingadores'        = @('Vingadores', 'The Avengers')
    'avatar'            = @('Avatar')
}

function Norm-Title($s) {
    $s = "$s".ToLower()
    $s = $s -replace '(\d)\s*[\u00ba\u00aa\u00b0]','$1' -replace '[\u00ba\u00aa\u00b0]',''
    $s = $s -replace '\b\d+\s*(a|\u00aa)?\s*temporada\b','' -replace '\bseason\s*\d+\b',''
    $s = $s -replace '[:\-\u2013\u2014_.,]',' ' -replace '[^\p{Ll}\p{Nd} ]',''
    ($s -replace '\s+',' ').Trim()
}

# fracao das palavras do resultado ($nm) presentes na busca ($qn)
function Get-WordOverlap($qn, $nm) {
    $qw = @($qn -split ' ' | Where-Object { $_.Length -ge 2 })
    $nw = @($nm -split ' ' | Where-Object { $_.Length -ge 2 })
    if ($nw.Count -eq 0) { return 0 }
    $common = ($nw | Where-Object { $qw -contains $_ }).Count
    return [double]$common / $nw.Count
}

function Invoke-Tmdb([string]$path, [string]$extra = '', [string]$lang = 'pt-BR') {
    $sep = if ($path.Contains('?')) { '&' } else { '?' }
    $url = "https://api.themoviedb.org/3$path$sep" + "api_key=$ApiKey&language=$lang$extra"
    foreach ($n in 1..3) {
        try { return Invoke-RestMethod $url -TimeoutSec 25 }
        catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
            Start-Sleep -Milliseconds (700 * $n)
        }
    }
    return $null
}

function Find-TmdbTv([string]$folderName) {
    $base = ($folderName -replace '\s*[-\u2013]\s*\d+\s*(a|\u00aa)?\s*Temporada\s*$','' `
                         -replace '\s*\d+\s*(a|\u00aa)?\s*Temporada\s*$','').Trim()
    $key = Norm-Title $base
    $queries = @()
    if ($script:TmdbAlias.ContainsKey($key)) { $queries += $script:TmdbAlias[$key] }
    $queries += $base
    $queries += ($base -replace '\s+\d+\s*$','')
    $queries = $queries | Where-Object { $_ -and $_.Trim().Length -ge 2 } | Select-Object -Unique

    $best = $null; $bestScore = -1e9; $bestOv = 0
    foreach ($q in $queries) {
        $qn = Norm-Title $q
        $r = Invoke-Tmdb '/search/tv' ('&query=' + [uri]::EscapeDataString($q))
        foreach ($h in ($r.results | Select-Object -First 6)) {
            $hn = "$($h.name)"; $ho = "$($h.original_name)"
            $ov = [Math]::Max((Get-WordOverlap $qn (Norm-Title $hn)), (Get-WordOverlap $qn (Norm-Title $ho)))
            $sc = ($ov * 4000) + [double]$h.popularity
            if ((Norm-Title $hn) -eq $qn -or (Norm-Title $ho) -eq $qn) { $sc += 3000 }
            if ($sc -gt $bestScore) { $bestScore = $sc; $best = $h; $bestOv = $ov }
        }
        if ($best -and $bestOv -ge 0.8) { break }
        Start-Sleep -Milliseconds 150
    }
    if ($best -and $bestOv -ge 0.34) { return $best }
    return $null
}

# "Anaconda (2025) [1080p].mkv" -> @{ Title='Anaconda'; Year=2025 }
function Get-TitleYear([string]$name) {
    $n = [IO.Path]::GetFileNameWithoutExtension($name)
    $year = $null
    if ($n -match '\((19|20)\d{2}\)') { $year = [int]($matches[0] -replace '[()]','') }
    $t = $n -replace '\((19|20)\d{2}\).*$','' -replace '\[[^\]]*\].*$',''
    $t = ($t -replace '\s*[-\u2013:]\s*$','' -replace '\s{2,}',' ').Trim()
    return [pscustomobject]@{ Title = $t; Year = $year }
}

function Find-TmdbMovie([string]$fileName) {
    $ty = Get-TitleYear $fileName
    $title = $ty.Title; $year = $ty.Year
    $queries = @($title, ($title -replace '\s+(\d+)\s*[-\u2013:]\s*','$1 '), ($title -replace '\s+\d+\s*[-\u2013:]\s*',' '),
                 ($title -replace '\s*[-\u2013:].*$','')) | Where-Object { $_ -and $_.Trim().Length -ge 2 } |
               ForEach-Object { $_.Trim() } | Select-Object -Unique
    $best = $null; $bestScore = -1e9
    foreach ($cand in $queries) {
        $qn = Norm-Title $cand
        $r = Invoke-Tmdb '/search/movie' ('&include_adult=false&query=' + [uri]::EscapeDataString($cand))
        foreach ($h in ($r.results | Select-Object -First 6)) {
            $s = [double]$h.popularity
            $tn = Norm-Title $h.title; $on = Norm-Title $h.original_title
            if ($tn -eq $qn -or $on -eq $qn) { $s += 5000 }
            elseif ($tn -and ($tn.StartsWith($qn) -or $qn.StartsWith($tn))) { $s += 800 }
            if ($year -and "$($h.release_date)" -match '^(\d{4})') {
                $diff = [Math]::Abs([int]$matches[1] - $year)
                if ($diff -eq 0) { $s += 2000 } elseif ($diff -le 1) { $s += 600 } elseif ($diff -le 2) { $s += 100 } else { $s -= 800 }
            }
            if ($s -gt $bestScore) { $bestScore = $s; $best = $h }
        }
        if ($best -and (Norm-Title $best.title) -eq (Norm-Title $title) -and
            (-not $year -or ("$($best.release_date)" -match "^$year"))) { break }
        Start-Sleep -Milliseconds 150
    }
    if ($best -and $bestScore -gt 0) { return $best }
    return $null
}

function Find-TmdbCollection([string]$folderName) {
    $key = Norm-Title $folderName
    $names = @($folderName)
    if ($script:TmdbCollectionAlias.ContainsKey($key)) { $names = $script:TmdbCollectionAlias[$key] }
    $best = $null; $bestOv = 0
    foreach ($q in $names) {
        $qn = Norm-Title $q
        $r = Invoke-Tmdb '/search/collection' ('&query=' + [uri]::EscapeDataString($q))
        foreach ($h in ($r.results | Select-Object -First 8)) {
            $a = ((Norm-Title $h.name) -replace '\b(colecao|collection|saga|trilogia|duologia|pentalogia|filmes|the movies?)\b','' -replace '\s+',' ').Trim()
            $b = ((Norm-Title $h.original_name) -replace '\b(colecao|collection|saga|trilogia|duologia|pentalogia|filmes|the movies?)\b','' -replace '\s+',' ').Trim()
            $ov = [Math]::Max((Get-WordOverlap $qn $a), (Get-WordOverlap $qn $b))
            if ($ov -gt $bestOv) { $bestOv = $ov; $best = $h }
        }
        if ($bestOv -ge 0.85) { break }
        Start-Sleep -Milliseconds 150
    }
    if ($best -and $bestOv -ge 0.5) { return $best }
    return $null
}

# numero da temporada pelo nome da pasta (mesma regra do seasonNumber do app)
function Get-FolderSeason([string]$name) {
    if ($name -match '(\d{1,2})\s*[\u00aa\u00baa\u00b0]?\s*temporada') { return [int]$matches[1] }
    if ($name -match 'temporada\s*(\d{1,2})') { return [int]$matches[1] }
    if ($name -match 'season\s*(\d{1,2})') { return [int]$matches[1] }
    if ($name -match '\bS(\d{1,2})\b') { return [int]$matches[1] }
    return 0
}

# temporada/episodio de um arquivo; $folderSeason vale quando o nome nao diz
function Get-SeasonEpisode([string]$fileName, [int]$folderSeason = 0) {
    $n = [IO.Path]::GetFileNameWithoutExtension($fileName)
    if ($n -match '[sS](\d{1,2})[\s._-]*[eE](\d{1,3})') { return @{ S = [int]$matches[1]; E = [int]$matches[2] } }
    if ($n -match '\b(\d{1,2})\s*x\s*(\d{1,3})\b') { return @{ S = [int]$matches[1]; E = [int]$matches[2] } }
    $s = if ($folderSeason) { $folderSeason } else { 1 }
    if ($n -match '(?i)epis[o\u00f3]dio\s*(\d{1,3})') { return @{ S = $s; E = [int]$matches[1] } }
    if ($n -match '(?i)\bep\.?\s*(\d{1,3})\b') { return @{ S = $s; E = [int]$matches[1] } }
    if ($n -match '^\s*(\d{1,3})(?:\s|[._-])') { return @{ S = $s; E = [int]$matches[1] } }   # "02 O Comeco de Tudo"
    return $null
}

# baixa uma imagem do TMDB (tamanho w1280, w780, w342...) para $out
function Save-TmdbImage([string]$path, [string]$size, [string]$out) {
    if (-not $path) { return $false }
    # -OutFile trata [ ] como curinga ("Filme [1080p].jpg" falharia): baixa num nome neutro
    $tmp = Join-Path $env:TEMP ('tmdb_' + [guid]::NewGuid().ToString('N') + '.part')
    foreach ($n in 1..3) {
        try {
            Invoke-WebRequest "https://image.tmdb.org/t/p/$size$path" -OutFile $tmp -TimeoutSec 60
            Move-Item -LiteralPath $tmp -Destination $out -Force
            return $true
        } catch { Start-Sleep -Seconds 2 }
    }
    Remove-Item -LiteralPath $tmp -EA 0
    return $false
}
