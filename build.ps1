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

  NOTA: o script de envio de arquivo (enviar-para-tv.js) e suas dependencias
        (node_modules) ficam em pasta separada, fora daqui:
        ..\AmorecoFlix-Enviar-Arquivo\  (o build-web -e nao exclui pastas
        direito nessa versao do Tizen Studio, so arquivos individuais).
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

$proj  = $PSScriptRoot
$tizen = 'C:\tizen-studio\tools\ide\bin\tizen.bat'
$sdb   = 'C:\tizen-studio\tools\sdb.exe'
$build = Join-Path $proj '.buildResult'

Write-Host "==> build-web" -ForegroundColor Cyan
& cmd /c "`"$tizen`" build-web -- `"$proj`""
if ($LASTEXITCODE) { throw "build-web falhou ($LASTEXITCODE)" }

Write-Host "==> package (perfil: $Profile)" -ForegroundColor Cyan
& cmd /c "`"$tizen`" package -t wgt -s $Profile -- `"$build`""
if ($LASTEXITCODE) { throw "package falhou ($LASTEXITCODE)" }

$wgt = Get-ChildItem $build -Filter *.wgt | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "OK: $($wgt.FullName)  ($([math]::Round($wgt.Length/1KB,1)) KB)" -ForegroundColor Green

if ($Install) {
    Write-Host "==> sdb connect $Tv" -ForegroundColor Cyan
    & $sdb connect $Tv | Out-Host
    $serial = "${Tv}:26101"
    & $sdb devices | Out-Host

    Write-Host "==> tizen install" -ForegroundColor Cyan
    & cmd /c "`"$tizen`" install -n `"$($wgt.Name)`" -s $serial -- `"$build`""
    if ($LASTEXITCODE) { throw "install falhou ($LASTEXITCODE)" }

    Write-Host "==> tizen run" -ForegroundColor Cyan
    & cmd /c "`"$tizen`" run -p $AppId -s $serial"
}
