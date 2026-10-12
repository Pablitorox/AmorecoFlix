# AmorecoFlix - Tizen Web App

Reprodutor de midia autonomo para Samsung Smart TV. **Rodando na TV
`UN50DU7700` (Tizen 9.0)** via sideload. Le videos da pasta `AmorecoFlix` de
um HD USB conectado direto na TV e guarda o progresso ("Continuar assistindo").

> **Gotcha descoberto na pratica:** a TV Samsung **recusa a instalacao se o
> `<name>` do `config.xml` tiver espacos**. Use hifen (`Meu-Player-USB`) ou
> uma palavra so (`AmorecoFlix`).
> (Sintoma: `Failed to install Tizen application` em ~1,3s, sem log.)

## Arquivos

### App (vai para dentro do `.wgt`)

| Arquivo       | Papel |
|---------------|-------|
| `config.xml`  | Manifesto Tizen + privilegios (filesystem, content, tv.inputdevice, ...). |
| `index.html`  | Estrutura: **Continuar assistindo** + **Navegacao de arquivos** + tela do player. |
| `app.js`      | Logica: `mapUsb()` (tizen.filesystem), `Player` (webapis.avplay + fallback `<video>`), `ProgressStore` (progresso no HD), proximo episodio, NetUpload e navegacao por D-pad. |
| `style.css`   | Tema escuro, estados `:focus` / `:hover` / `.focused` bem visiveis para o controle. |
| `icon.png`    | Icone do app. |

So esses 5 arquivos entram no pacote (`$AppFiles` no `build.ps1`). Arquivo
novo do app tem que ser adicionado la.

### Scripts do PC

| Script | Papel |
|--------|-------|
| `build.ps1` | Monta o app numa pasta temporaria + `build-web` + `package` assinado + (opcional) instala na TV. |
| `lib.ps1` | Funcoes comuns: `Get-EnvValue`, `Get-TmdbApiKey` (`.env`), `Find-FfTool` (ffmpeg/ffprobe). |
| `Importador.bat` / `importador.ps1` | Janela para passar episodios de Downloads para o HD (analise, copia verificada, legendas, miniaturas, revisao por IA opcional). |
| `import-serie.ps1` | Mesmo fluxo, por linha de comando. |
| `checar-compatibilidade.ps1` | Integridade e codecs de risco para a TV (tambem usado como biblioteca pelos importadores). |
| `detectar-creditos.ps1` / `skip-anime.ps1` | Preenchem o `skip.json` (creditos `cr`, abertura/encerramento `op`/`ed`). |
| `gerar-thumbnails.ps1`, `capas-temporada.ps1`, `posters-*.ps1` | Capas e miniaturas em `AmorecoFlix/thumbs`. |
| `organizar-subs.ps1` | Move legendas para `AmorecoFlix/subs`. |
| `limpar-lixo.ps1` | Remove arquivos de release/propaganda (simulacao por padrao; `-Apply` apaga). |
| `transferir-hd.ps1` | Copia pastas grandes com Robocopy. |
| `calendario-lancamentos.ps1` + `calendario.html` | Calendario de episodios novos (gera `calendario-data.js`, ignorado pelo git: contem a chave). |

Chaves (TMDB, Gemini/Anthropic) ficam no `.env` (fora do git e do `.wgt`).

## Como o app funciona

1. Ao abrir, `scanUsb()` chama `tizen.filesystem.listStorages()` e filtra os
   storages `EXTERNAL` / `removable*` no estado `MOUNTED`.
2. Resolve o primeiro, entra na pasta `AmorecoFlix` e lista pastas + videos
   (`mp4, mkv, avi, mov, ts, ...`), com ordenacao **natural** (`S01E02` antes de `S01E10`).
   `thumbs/`, `subs/` e `skip.json` sao (re)lidos a cada escaneamento (tecla VERMELHA).
3. Ao abrir um video: `webapis.avplay.open() -> prepareAsync() -> play()`, e faz
   `seekTo()` se houver progresso salvo (com nova tentativa um pouco antes do
   ponto, se o seek falhar).
4. A cada 3 s grava `{ path, position, duration, done }` no `localStorage`; no
   HD (`AmorecoFlix/progresso.json` + copia `progresso.bak.json`) grava no
   maximo a cada 30 s e sempre ao pausar, parar ou sair. O arquivo do HD e a
   fonte de verdade (sobrevive a reinstalacoes); se ele estiver corrompido, o
   app usa o `.bak`.
5. Passou de 92% da duracao => marcado como `done` e sai de "Continuar assistindo".
6. No fim do video, `findNextEpisode()` oferece o proximo arquivo da pasta; no
   ultimo episodio da temporada, o 1o da pasta da temporada seguinte
   (`Show - 2ª Temporada`, `Temporada 2`, `Season 2`, `S02`).
7. **Card "Proximo episodio" nos creditos:** quando o episodio chega ao inicio
   dos creditos aparece o card (OK = assistir, ▲ = ocultar; sem contagem). O
   momento vem de, nesta ordem: fim do encerramento (`ed`) de anime, `cr[0]` do
   `skip.json`, ou o padrao `fim - 45 s`. Ao chegar no fim sem ter agido, vale
   a contagem de 5 s (autoplay) de sempre.

### Detectar o inicio dos creditos (`detectar-creditos.ps1`)

Analisa o final de cada episodio com ffmpeg (fundo escuro + texto, trecho
continuo perto do fim) e grava `"cr": [inicio, duracao]` no `skip.json`,
sem apagar `op`/`ed`. Roda uma vez por episodio (cache em
`creditos-analisados.json`); depois de importar series novas, rode de novo.

```powershell
.\detectar-creditos.ps1                        # biblioteca toda (pula analisados)
.\detectar-creditos.ps1 -Only "The Originals"  # uma serie
.\detectar-creditos.ps1 -Path ep.mkv -Show     # testa 1 arquivo sem gravar
```

Creditos sobre imagem (finais de temporada etc.) nao sao detectados; nesses
o app usa o padrao `fim - 45 s`.

### Teclas do controle

| Tecla | Tela inicial | Player |
|-------|--------------|--------|
| Direcionais | mover foco | ESQ/DIR = voltar/avancar (segurar acelera, com previa); BAIXO = botoes |
| OK / Enter | abrir (segurar no Continuar = opcoes) | play / pause; pula abertura / assiste o proximo quando o botao aparece |
| PLAY / PAUSE | - | play / pause |
| >> / << | - | +85s / -85s |
| RETURN | subir de pasta | parar e voltar |
| VERMELHO (A) | reescanear USB | - |
| VERDE (B) | console de debug | console de debug |
| AMARELO (C) | - | audio e legendas |
| AZUL (D) | status da rede / cancelar envio | - |

---

## Ambiente ja instalado nesta maquina

| Componente | Local / versao |
|---|---|
| Tizen Studio | `C:\tizen-studio` (6.1) + dados em `C:\tizen-studio-data` |
| JDK | Eclipse Temurin 17 (`JAVA_HOME` no PATH da maquina) |
| Extensoes | TV Extensions 10.0, Samsung Certificate Extension, Certificate Manager |
| CLI | `tizen` 2.5.25 e `sdb` 4.2.36 (no PATH: `C:\tizen-studio\tools` e `...\tools\ide\bin`) |
| Certificado | author `MeuPlayerAuthor.p12` em `C:\tizen-studio-data\keystore\author` (senha guardada no Certificate Manager) |
| Perfil de assinatura | `MeuPlayer` (ativo) em `C:\tizen-studio-data\profile\profiles.xml` |

> O perfil `MeuPlayer` usa o **distribuidor Tizen** (bom p/ emulador). Para a TV
> Samsung de varejo e preciso um **perfil Samsung** - veja a secao 3.

## Build (ja funciona por linha de comando)

Na pasta do projeto:
```powershell
.\build.ps1
```
Gera `.buildResult\AmorecoFlix.wgt` (assinado com o perfil `SamsungTV`).
O build roda em `%TEMP%\amorecoflix-build`, que recebe **so** os arquivos do
app. Nunca rode `tizen build-web` direto na pasta do projeto: ele empacota
tudo (`.env` com as chaves, `.git`, scripts, scratchpad).

### 1. Emulador de TV

```
C:\tizen-studio\ide\TizenStudio.exe   >  Tools > Emulator Manager
  > Create > escolha uma imagem "TV Samsung" (UHD)  >  Launch
.\build.ps1 -Profile MeuPlayer
tizen install -n AmorecoFlix.wgt -- .buildResult
tizen run  -p MYpLyr0001.MeuPlayer
```

> **Limitacao do emulador:** nao acessa HD USB real e o `AVPlay` normalmente nao
> decodifica video. O app tem *fallbacks*: sem `webapis.avplay` usa `<video>`
> HTML5; sem `tizen.filesystem` a lista fica vazia. Para exercitar a navegacao,
> `sdb push` alguns `.mp4` e troque `scanUsb()` temporariamente para
> `tizen.filesystem.resolve('documents', ...)`. **USB + AVPlay de verdade so na TV.**

### 2. Conectar a TV (sideload)

1. Na TV (UN50DU7700): **Apps** > digite `12345` no controle > **Modo de
   Desenvolvedor = LIGADO** > informe o **IP do PC** > reinicie a TV.
2. PC e TV na **mesma rede**. No PC:
   ```powershell
   sdb connect IP_DA_TV        # porta 26101 e assumida
   sdb devices                 # deve listar a TV
   ```

### 3. Certificado Samsung (obrigatorio p/ TV de varejo)

O `.wgt` assinado com `MeuPlayer` **nao instala** numa Samsung de loja
(erro de assinatura de distribuidor). Crie um perfil Samsung:

1. Abra o **Certificate Manager**
   (`C:\tizen-studio\tools\certificate-manager\certificate-manager.exe`).
2. `+` > **Samsung** > *Create a new certificate profile*.
3. Faca login na **conta Samsung** (voce faz isso - nao da p/ automatizar).
4. **Author certificate**: crie um novo (guarde a senha).
5. **Distributor certificate**: com a TV ja conectada via `sdb`, o wizard le o
   **DUID** dela automaticamente. Confirme.
6. O perfil (ex.: `SamsungTV`) fica ativo.

Depois:
```powershell
.\build.ps1 -Profile SamsungTV -Install -Tv IP_DA_TV
```
ou, com o `.wgt` ja gerado:
```powershell
tizen install -n AmorecoFlix.wgt -- .buildResult
sdb shell 0 was_execute MYpLyr0001.MeuPlayer
```

### 4. Debug na TV

```powershell
sdb dlog -v time TIZEN_WEB_APP:* ConsoleMessage:* *:S   # logs do console.log
```
**Web Inspector**: com o app aberto na TV,
`sdb shell 0 debug MYpLyr0001.MeuPlayer` devolve uma porta; abra
`http://IP_DA_TV:PORTA` no **Chrome do PC** = DevTools completo da TV.

---

## Proximos passos sugeridos

1. ~~Miniaturas~~ **FEITO** - `ContentIndex` (app.js) usa `tizen.content.find`
   + `scanDirectory`; a TV gera as thumbnails dos videos do USB e cruzamos pelo
   caminho do arquivo. Fallback: card com emoji quando nao ha thumbnail.
2. ~~Legendas~~ **FEITO** - pasta central `AmorecoFlix/subs` + faixas internas,
   painel na tecla AMARELA.
3. **Varrer subpastas** para montar um catalogo global (filmes x series) em vez
   de navegar pasta a pasta.
4. **IndexedDB** no lugar do `localStorage` se o historico crescer muito.
5. **MediaController** (`webapis` / `tizen.mediacontroller`) para o play/pause
   pelo botao do controle funcionar mesmo com a UI escondida.
6. Tratar **multiplos storages** (varios HDs) na tela inicial.
