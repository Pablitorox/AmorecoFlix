<#
  transferir-hd.ps1 - copia pasta(s) para o HD usando Robocopy (nativo do
  Windows), configurado pra ser rapido, nao travar horas num arquivo
  problematico, e mostrar erro NA HORA (nao so no resumo final).

  Se um arquivo com o mesmo nome ja existir no destino e for diferente
  (tamanho/data), o Robocopy sobrescreve sozinho. Arquivos identicos sao
  pulados (nao perde tempo recopiando o que ja esta certo).

  Uso:
    .\transferir-hd.ps1 -Src "$env:USERPROFILE\Downloads\Serie X" -Dst "E:\AmorecoFlix\Series\Serie X"

  Parametros opcionais:
    -Threads 8      numero de copias em paralelo (padrao 8; HD mecanico USB
                     externo nao ganha muito acima disso - pode ate piorar
                     por causa do movimento da cabeca de leitura. SSD externo
                     pode subir pra 16-32.)
    -ForceOverwrite  forca recopiar mesmo arquivos identicos (raro precisar)
#>
param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Dst,
    [int]$Threads = 8,
    [switch]$ForceOverwrite
)

if (-not (Test-Path -LiteralPath $Src)) { Write-Error "origem nao existe: $Src"; exit 1 }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null

$logDir = Join-Path $PSScriptRoot 'scratchpad'
New-Item -ItemType Directory -Force -Path $logDir -EA 0 | Out-Null
$log = Join-Path $logDir ("transfer_" + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.log')

$flags = @(
    '/E'                # copia subpastas (incluindo vazias)
    '/J'                # I/O sem buffer - mais rapido pra arquivos grandes
    "/MT:$Threads"      # copias em paralelo
    '/R:1'              # so 1 tentativa por arquivo problematico...
    '/W:2'              # ...esperando 2s (padrao seria 1 milhao de tentativas x 30s = trava horas sem voce ver)
    '/NP'               # sem barra de % (log mais limpo)
    '/NDL'              # nao lista nome de pasta (log mais enxuto)
    "/LOG+:$log"        # grava log em arquivo
    '/TEE'              # ...e mostra no console ao mesmo tempo (erro na hora, nao so no fim)
)
if ($ForceOverwrite) { $flags += '/IS' }   # inclui/recopia arquivos "iguais" tambem

Write-Host "== Transferindo =="   -ForegroundColor Cyan
Write-Host "  De : $Src"
Write-Host "  Para: $Dst"
Write-Host "  Log : $log"
Write-Host ""

& robocopy $Src $Dst @flags
$code = $LASTEXITCODE

# Robocopy usa codigo de saida em bitmask - 0 a 7 = sucesso (com variacoes
# de "o que foi feito"), 8+ = houve falha real.
if ($code -ge 8) {
    Write-Host ""
    Write-Host "FALHOU (codigo $code) - veja o log: $log" -ForegroundColor Red
    exit 1
} else {
    $msg = switch ($code) {
        0 { 'nada para copiar (destino ja identico)' }
        1 { 'arquivos copiados com sucesso' }
        2 { 'arquivos extras no destino (nao copiados, so listados)' }
        3 { 'copiou + tem extras no destino' }
        default { "concluido (codigo $code)" }
    }
    Write-Host ""
    Write-Host "OK - $msg" -ForegroundColor Green

    # Checa compatibilidade dos videos recem-transferidos com o player da TV
    # (heuristico - ver checar-compatibilidade.ps1). Nao falha a transferencia.
    $compatLib = Join-Path $PSScriptRoot 'checar-compatibilidade.ps1'
    if (Test-Path -LiteralPath $compatLib) {
        & $compatLib -Path $Dst
    }
    exit 0
}
