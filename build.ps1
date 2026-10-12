<#
  build.ps1 - compila, assina e (opcionalmente) instala/roda o app na TV Samsung.

  Uso:
    .\build.ps1                                  # build + package (.wgt assinado)
    .\build.ps1 -Install                         # + instala e abre na TV (usa -Tv padrao)
    .\build.ps1 -Install -Tv 192.168.0.2         # especifica o IP da TV
    .\build.ps1 -Profile MeuPlayer               # assina com outro perfil (ex.: emulador)

  Pre-requisitos: Tizen Studio em C:\tizen-studio, JDK 17, perfil 'SamsungTV' criado
  no Certificate Manager (author + distributor Public com o DUID da TV).

  NOTA: o <name> no config.xml NAO pode ter espacos - a TV Samsung recusa a
        instalacao. Use hifen (Meu-Player-USB).

  NOTA: o build roda numa pasta temporaria que recebe SO os arquivos do app
        ($AppFiles). Antes o build-web empacotava a pasta do projeto inteira
        (.env com as chaves, .git, scripts .ps1, scratchpad...) e o -e dessa
        versao do Tizen Studio nao exclui pastas. Arquivo novo do app (ex.:
        outro .js/.css) tem que entrar em $AppFiles - pastas inteiras (js,
        fonts) entram com tudo o que tiverem dentro. Se o index.html ou o
        style.css apontarem para um arquivo que ficou de fora, o build para.
#>
param(
    [string]$Profile = 'SamsungTV',
    [switch]$Install,
    [string]$Tv = '192.168.0.2',
    [string]$AppId = 'MYpLyr0001.MeuPlayer'
)

$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME','Machine')
$env:Path      = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path

# unicos arquivos (e pastas) que vao para dentro do .wgt
$AppFiles = @('config.xml', 'index.html', 'app.js', 'style.css', 'icon.png', 'js', 'fonts')

$proj  = $PSScriptRoot
$tizen = 'C:\tizen-studio\tools\ide\bin\tizen.bat'
$sdb   = 'C:\tizen-studio\tools\sdb.exe'
$out   = Join-Path $proj '.buildResult'
$stage = Join-Path $env:TEMP 'amorecoflix-build'

Write-Host "==> preparando $stage" -ForegroundColor Cyan
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($f in $AppFiles) {
    $src = Join-Path $proj $f
    if (-not (Test-Path -LiteralPath $src)) { throw "arquivo do app ausente: $f" }
    Copy-Item -LiteralPath $src -Destination $stage -Recurse
}

# todo arquivo local citado no index.html (src/href) e no style.css (url())
# precisa estar no pacote - senao a TV abre o app sem ele, sem erro nenhum
$refs = @()
$html = Get-Content -LiteralPath (Join-Path $stage 'index.html') -Raw -Encoding UTF8
$refs += [regex]::Matches($html, '(?:src|href)="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$css = Get-Content -LiteralPath (Join-Path $stage 'style.css') -Raw -Encoding UTF8
$refs += [regex]::Matches($css, 'url\(\s*[''"]?([^''")]+)') | ForEach-Object { $_.Groups[1].Value }
$missing = $refs | Where-Object { $_ -notmatch '^(\$WEBAPIS|https?:|data:|#)' } |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $stage ($_ -split '[?#]')[0])) } |
    Sort-Object -Unique
if ($missing) { throw "index.html/style.css citam arquivos fora do pacote (`$AppFiles): $($missing -join ', ')" }

$build = Join-Path $stage '.buildResult'

Write-Host "==> build-web" -ForegroundColor Cyan
& cmd /c "`"$tizen`" build-web -- `"$stage`""
if ($LASTEXITCODE) { throw "build-web falhou ($LASTEXITCODE)" }

Write-Host "==> package (perfil: $Profile)" -ForegroundColor Cyan
& cmd /c "`"$tizen`" package -t wgt -s $Profile -- `"$build`""
if ($LASTEXITCODE) { throw "package falhou ($LASTEXITCODE)" }

$built = Get-ChildItem $build -Filter *.wgt | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) { throw "nenhum .wgt gerado em $build" }

# .buildResult do projeto guarda so o .wgt final
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -LiteralPath $built.FullName -Destination $out
$wgt = Get-Item -LiteralPath (Join-Path $out $built.Name)
Write-Host "OK: $($wgt.FullName)  ($([math]::Round($wgt.Length/1KB,1)) KB)" -ForegroundColor Green

if ($Install) {
    Write-Host "==> sdb connect $Tv" -ForegroundColor Cyan
    & $sdb connect $Tv | Out-Host
    $serial = "${Tv}:26101"
    & $sdb devices | Out-Host

    Write-Host "==> tizen install" -ForegroundColor Cyan
    & cmd /c "`"$tizen`" install -n `"$($wgt.Name)`" -s $serial -- `"$out`""
    if ($LASTEXITCODE) { throw "install falhou ($LASTEXITCODE)" }

    Write-Host "==> tizen run" -ForegroundColor Cyan
    & cmd /c "`"$tizen`" run -p $AppId -s $serial"
}
