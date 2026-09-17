# Meu Player USB - Tizen Web App

Reprodutor de midia autonomo para Samsung Smart TV. **Rodando na TV
`UN50DU7700` (Tizen 9.0)** via sideload. Le videos de um HD/pendrive USB
conectado direto na TV e guarda o progresso ("Continuar assistindo").

> **Gotcha descoberto na pratica:** a TV Samsung **recusa a instalacao se o
> `<name>` do `config.xml` tiver espacos**. Use hifen: `Meu-Player-USB`.
> (Sintoma: `Failed to install Tizen application` em ~1,3s, sem log.)

## Arquivos

| Arquivo       | Papel |
|---------------|-------|
| `config.xml`  | Manifesto Tizen + privilegios (filesystem, externalstorage, tv.inputdevice, mediacontroller, power). |
| `index.html`  | Estrutura: **Continuar assistindo** + **Navegacao de arquivos** + tela do player. |
| `app.js`      | Logica: `mapUsb()` (tizen.filesystem), `Player` (webapis.avplay + fallback `<video>`), `ProgressStore` (localStorage), proximo episodio e navegacao por D-pad. |
| `style.css`   | Tema escuro, estados `:focus` / `:hover` / `.focused` bem visiveis para o controle. |
| `icon.png`    | Placeholder 512x512 (gerado). Troque por um icone real quando quiser. |
| `build.ps1`   | Script: `build-web` + `package` assinado + (opcional) instalar na TV. |

## Como o app funciona

1. Ao abrir, `scanUsb()` chama `tizen.filesystem.listStorages()` e filtra os
   storages `EXTERNAL` / `removable*` no estado `MOUNTED`.
2. Resolve o primeiro (`removable/drive1`) e lista pastas + videos
   (`mp4, mkv, avi, mov, ts, ...`), com ordenacao **natural** (`S01E02` antes de `S01E10`).
3. Ao abrir um video: `webapis.avplay.open() -> prepareAsync() -> play()`, e faz
   `seekTo()` se houver progresso salvo.
4. A cada 5s, ao pausar e ao sair do app, grava
   `{ path, position, duration, done }` no `localStorage`.
5. Passou de 92% da duracao => marcado como `done` e sai de "Continuar assistindo".
6. No fim do video, `findNextEpisode()` procura o proximo arquivo (padrao `SxxEyy`)
   e oferece "Assistir agora".

### Teclas do controle

| Tecla | Tela inicial | Player |
|-------|--------------|--------|
| Direcionais | mover foco | ESQ/DIR = -10s / +10s |
| OK / Enter | abrir | play / pause |
| PLAY / PAUSE | - | play / pause |
| >> / << | - | +30s / -30s |
| RETURN | subir de pasta | parar e voltar |
| VERMELHO (A) | reescanear USB | - |

---

## Ambiente ja instalado nesta maquina

| Componente | Local / versao |
|---|---|
| Tizen Studio | `C:\tizen-studio` (6.1) + dados em `C:\tizen-studio-data` |
| JDK | Eclipse Temurin 17 (`JAVA_HOME` no PATH da maquina) |
| Extensoes | TV Extensions 10.0, Samsung Certificate Extension, Certificate Manager |
| CLI | `tizen` 2.5.25 e `sdb` 4.2.36 (no PATH: `C:\tizen-studio\tools` e `...\tools\ide\bin`) |
| Certificado | author `MeuPlayerAuthor.p12` em `C:\tizen-studio-data\keystore\author` (senha `tizenapp123`) |
| Perfil de assinatura | `MeuPlayer` (ativo) em `C:\tizen-studio-data\profile\profiles.xml` |

> O perfil `MeuPlayer` usa o **distribuidor Tizen** (bom p/ emulador). Para a TV
> Samsung de varejo e preciso um **perfil Samsung** - veja a secao 3.

## Build (ja funciona por linha de comando)

Na pasta do projeto:
```powershell
.\build.ps1
```
Gera `.buildResult\Meu Player USB.wgt` (assinado). Equivalente manual:
```powershell
tizen build-web -- .
tizen package -t wgt -s MeuPlayer -- .buildResult
```

### 1. Emulador de TV

```
C:\tizen-studio\ide\TizenStudio.exe   >  Tools > Emulator Manager
  > Create > escolha uma imagem "TV Samsung" (UHD)  >  Launch
tizen install -n "Meu Player USB.wgt" -- .buildResult
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
ou manual:
```powershell
tizen package -t wgt -s SamsungTV -- .buildResult
tizen install -n "Meu Player USB.wgt" -- .buildResult
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
2. **Legendas**: `avplay.setExternalSubtitlePath()` para `.srt` de mesmo nome.
3. **Varrer subpastas** para montar um catalogo global (filmes x series) em vez
   de navegar pasta a pasta.
4. **IndexedDB** no lugar do `localStorage` se o historico crescer muito.
5. **MediaController** (`webapis` / `tizen.mediacontroller`) para o play/pause
   pelo botao do controle funcionar mesmo com a UI escondida.
6. Tratar **multiplos storages** (varios HDs) na tela inicial.
