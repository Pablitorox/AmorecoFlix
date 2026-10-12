# Plano de implementação — novo design do AmorecoFlix

Protótipo de referência: https://claude.ai/artifact/V9AxmuAiwkTo2ZcstYXhnw (12 telas)
Base de código: commit `e210a79` (master)
Escrito em: 12/10/2026

## Andamento (branch `redesign`)

| Fase | Situação |
|---|---|
| 0 — Base | ✅ feita (`ad1cf22`), testada no simulador; falta conferir na TV a linha `[css]` do log |
| 1 — Player | ✅ feita (`2d116ab`), testada no simulador; **falta testar na TV** |
| 2 a 7 | a fazer |

---

## 0. Resumo

- **8 fases** (0 a 7). Cada fase termina com o app funcionando e instalável. Nenhuma fase deixa o app quebrado no meio do caminho.
- **Ordem:** base → player → dados → início → página da série → biblioteca → pastas → polimento.
- **O player vem primeiro.** É o que você usa todo dia e não depende de metadados do TMDB: dá para entregar sem mexer no HD.
- **O motor de retomada não muda.** A fase 1 só acrescenta avisos (eventos) para a tela "Retomando". A lógica que corrigimos no `e210a79` fica intacta.
- **Testes:** primeiro no simulador, no navegador. Na TV, só com a sua autorização, uma vez por fase.

```
Início ⇄ Biblioteca ⇄ Pastas            (abas no topo)
  │          │           │
  │          ▼           ▼
  ├──► Página da série ──► Player ◄── (arquivo nas Pastas)
  └──► Player (Continuar)
           ├─ Retomando      (sobreposição)
           ├─ Áudio e legendas (painel lateral)
           ├─ Episódios       (painel inferior)
           ├─ Pular abertura  (botão)
           └─ Próximo episódio (card nos créditos)
Segurar OK num card ─► Opções (diálogo)
Sem HD ─► tela "Conecte o HD"
```

---

## 1. Ponto de partida: o que já existe e o que acontece com cada parte

| Parte atual (app.js) | Destino no novo design |
|---|---|
| `Player` (retomada, `checkStall`, faixas) — `app.js:253` | Fica. Ganha um gancho `Player.onResume` para a tela "Retomando". |
| `ProgressStore` — `app.js:1067` | Fica. Ganha consultas por título e "marcar como visto" sem ter tocado. |
| `ThumbsFolder` (`thumbs/`) — `app.js:1563` | Artes dos cards: stills de episódio e capas de pasta (já são 648). |
| `SkipData` (`skip.json`: op/ed/cr) — `app.js:1622` | Botão "Pular abertura" e **marca de créditos** na barra. |
| `SubsFolder`, `findExtSubs` | Painel "Áudio e legendas". |
| `UI.buildCard`, `renderFileList` | Tela Pastas, com visual novo. |
| `Nav` (grupos fixos, if/else por grupo) — `app.js:2405` | **Substituído** por um Nav configurável por tela (fase 0). |
| `onKeyDown` (um switch para tudo) — `app.js:2589` | **Dividido**: cada tela/camada trata as próprias teclas. |
| `ContextMenu` (`#ctx-menu`) — `app.js:2995` | Vira o diálogo **Opções**. |
| `#next-toast` | Vira o **card de Próximo episódio** (visual novo, mesmas regras). |
| `#skip-btn` | Visual novo, com barrinha do tempo da abertura. |
| `#p-settings` + engrenagem | Vira o **painel lateral Áudio e legendas**. |
| `#btn-stop` | Sai (STOP e RETURN já param). |
| `UI.toast` | Fica. |

### Limitações da TV que valem para o plano todo

1. O vídeo do AVPlay fica num **plano atrás da página**. Tudo no player precisa de fundo transparente (`body.playing`). Nenhum painel pode cobrir a tela inteira com cor opaca, a não ser que a intenção seja esconder o vídeo.
2. `inset:` não funciona no navegador da TV: usar `top/left/right/bottom`.
3. Sem Web Inspector: depurar pelo console da tecla **VERDE** e pelo `AmorecoFlix/amorecoflix.log`.
4. Capturar quadro do vídeo dá imagem preta. A prévia do avanço mostra **só o tempo**, como no protótipo.
5. Só entram no `.wgt` os arquivos listados em `$AppFiles` no `build.ps1`.
6. Nada de `filter: blur()` ou `backdrop-filter` em áreas grandes: pesa no processador da TV.

---

## 2. Decisões de arquitetura

### 2.1 Arquivos

O `app.js` já tem ~3.500 linhas. As telas novas vão para arquivos próprios, carregados por `<script>` em ordem, sem bundler e no mesmo estilo do código atual (`var X = (function () { ... })();`, ES5, comentários sem acento):

```
index.html
style.css                 tokens + base + componentes
app.js                    núcleo: DebugLog, USB, Player, ProgressStore, módulos de dados, boot
js/nav.js                 Nav v2 + teclas (segurar OK, repetição)
js/router.js              Screens (telas) + Layers (camadas por cima)
js/components.js          cards, pôster, botões, chips, barra, anel, ícones SVG
js/library.js             Meta (biblioteca.json) + Library (títulos/temporadas/episódios)
js/player-ui.js           HUD, avanço, pular abertura, próximo, faixas, episódios, retomando
js/screens/home.js        Início + Opções
js/screens/series.js      Página da série / filme / coleção
js/screens/catalog.js     Biblioteca
js/screens/folders.js     Pastas
js/screens/nohd.js        Sem HD
fonts/                    Sora 600/700 e Figtree 400/500/600 (.woff2, licença OFL)
```

### 2.2 Telas e camadas (`js/router.js`)

```js
Screens.register('series', {
    el: document.getElementById('screen-series'),
    enter: function (params, isBack) { ... },   // monta ou restaura
    leave: function () { ... },                 // libera imagens grandes
    onKey: function (code, ev) { return true; } // true = tratou
});
Screens.go('series', { title: 'Animes/Death Parade' });
Screens.back();                                  // RETURN
Layers.open('options', { ... });  Layers.close();
```

- **Pilha de navegação:** RETURN volta para a tela anterior, com o foco onde estava. Na raiz (Início), RETURN não faz nada, como hoje.
- **Ordem das teclas:** globais (VERDE debug, AZUL rede, VERMELHO procurar HD fora do player) → camada do topo → tela atual.
- **Do player, RETURN volta para a tela de origem** (página da série, Início ou Pastas), não sempre para a inicial como hoje (`goHome`).

### 2.3 Nav v2 (`js/nav.js`)

Cada tela declara seus grupos de foco:

```js
Nav.define('home', [
    { id: 'tabs',     type: 'row',  down: 'hero' },
    { id: 'hero',     type: 'row',  up: 'tabs', down: 'continue' },
    { id: 'continue', type: 'rail', up: 'hero', down: 'nextup' },
    { id: 'nextup',   type: 'rail', up: 'continue' }
]);
```

- Tipos: `row` (botões lado a lado), `rail` (fileira que rola na horizontal), `grid` (colunas), `col` (lista vertical).
- **Memória do último item focado por grupo:** ao voltar da página da série, o foco volta para o mesmo card.
- **Troca de grupo pela posição:** ao descer de uma fileira para outra, vai para o item mais próximo na horizontal (pelo `getBoundingClientRect`), não para o primeiro.
- **Rolagem com `transform`:** `translateX` na fileira e `translateY` na tela, com transição de 200 ms. Substitui `scrollIntoView`, que é brusco e lento na TV.
- **Segurar OK genérico:** qualquer elemento com `data-hold="options"` abre Opções após 550 ms. Generaliza o `startHold`, que hoje só vale para "Continuar assistindo".
- **Tecla segurada:** no máximo um movimento a cada ~90 ms, para não atravessar a fileira inteira sem querer.

### 2.4 Tokens de design (`style.css`, `:root`)

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#0E0E10` | fundo |
| `--surface` | `#141418` | painéis, diálogo |
| `--surface-2` | `#1A1A1F` | placeholders |
| `--text` | `#F5F5F2` | texto |
| `--text-2` | `#B4B4B8` | secundário |
| `--text-3` | `#8E8E94` | dicas |
| `--accent` | `#E50914` | progresso, marca |
| `--ok` | `#5FD08A` | HD conectado, ✓ |
| foco | anel branco de 5px + `scale(1.04)` | todo item focável |
| raios | 12 / 14 / 18 px | cards / botões / diálogos |
| margens | 96px laterais, 64px no topo | todas as telas |
| tipos | Sora 700 (títulos), Figtree 400–600 (texto) | |
| escala | 88 / 56 / 44 / 34 / 26 / 24 / 22 / 20 px | destaque → dica |

Nenhum texto abaixo de 20px.

### 2.5 Componentes (`js/components.js`)

Funções que devolvem elementos prontos, usadas por todas as telas:

- `Card16x9({ art, badge, title, sub, pct, watched, current, hold })`: Continuar, Próximos, Episódios e Pastas.
- `Poster2x3({ art, title, sub, pct, isNew })`: Biblioteca.
- `Button({ kind: 'primary' | 'secondary' | 'icon', icon, label })`.
- `Chip({ label, active })`.
- `ProgressBar`, `Ring` (anel de contagem e da retomada).
- `Art`: imagem com reserva em bloco de cor (`hashHue`, que já existe) e **carregamento preguiçoso**: o `src` só é definido quando o card chega perto da área visível.
- `Icons`: os SVGs do protótipo (play, pausa, −10/+10, voltar, episódios, legendas, próximo, ✓, info, HD).

---

## Fase 0 — Base (tamanho M)

Objetivo: preparar o terreno sem mudar o que você vê. No fim desta fase, o app funciona igual ao de hoje.

1. Criar a branch `redesign`.
2. **build.ps1:** `$AppFiles` passa a aceitar pastas (`Copy-Item -Recurse`) e ganha `js/` e `fonts/`. Também ganha uma checagem: falha se o `index.html` referencia um arquivo que não entrou no pacote.
3. **Fontes:** baixar os `.woff2` de Sora e Figtree (Google Fonts, licença OFL) para `fonts/`, com `@font-face` no CSS. Peço sua autorização antes de baixar. Alternativa: usar as fontes do sistema (decisão D5).
4. **CSS:** tokens novos, `@font-face`, classes base (`.focus-ring`, `.t-hero`, `.t-h1`...). As telas antigas continuam funcionando.
5. **`js/nav.js`, `js/router.js`, `js/components.js`** como descrito na seção 2. A tela antiga (inicial + player) é registrada no router para manter tudo funcionando.
6. **Teste de recursos no boot:** registrar no log o resultado de `CSS.supports` para `gap`, `inset`, `aspect-ratio`, `-webkit-line-clamp` e `object-fit`. Se algo não existir na TV, uso alternativa já nesta fase.
7. **Simulador:** mover `scratchpad/simulador-tv` para `tools/simulador/` e versionar no git (hoje está fora, no `.gitignore`). Novos parâmetros: `?tela=`, `?hd=0`, `?retomada=lenta`, `?meta=0`.

**Pronto quando:** o app no simulador e na TV se comporta igual ao `e210a79`, e o log mostra os recursos de CSS da TV.

---

## Fase 1 — Player novo (tamanho G, prioridade)

Telas do protótipo: 7 (Retomando), 8 (Controles), 9 (Avançando), 10 (Pular abertura), 11 (Áudio e legendas), 12 (Créditos).

### 1.1 Estrutura (`index.html`, `#player-screen`)

```
#player-screen
  object#av-player, video#html5-player        (sem mudança)
  #p-center                                    (play/pausa no centro, sem mudança)
  #p-hud
    .p-scrim-top, .p-scrim-bottom              degradês
    header: #p-back (botão redondo ‹) + .p-crumb ("Death Parade · Temporada 1") + .p-title ("Episódio 7")
    .p-bar: #t-cur | trilho (#p-buf, #p-fill, #p-skipped, #p-knob, #p-credits) | #t-left ("−12:49")
    #p-bubble                                  balão do avanço (tempo + "+4:28")
    .p-row: #btn-play, #btn-rew, #btn-fwd  |  #btn-episodes, #btn-tracks, #btn-next
    #p-scrub-hint
  #p-skip        Pular abertura
  #p-nextcard    Próximo episódio
  #p-tracks      Áudio e legendas
  #p-episodes    Episódios
  #p-resume      Retomando
```

Saem: `#btn-stop`, `#p-gear`, `#p-settings` e `#next-toast`.

### 1.2 Controles e foco

| Situação | Tecla | Ação |
|---|---|---|
| HUD escondida | qualquer | mostra a HUD (como hoje). PLAY/PAUSE age direto. |
| Foco na barra (estado inicial) | ◀ ▶ toque | −10 s / +10 s |
| | ◀ ▶ segurado | avança acelerando: 10 s → 30 s → 1 min, com balão |
| | OK | play/pausa |
| | ▼ | desce para os botões (foco no Play, como na tela 8) |
| | ▲ | botão Voltar do topo |
| Foco nos botões | ◀ ▶ | percorre Play, −10, +10, Episódios, Áudio e legendas, Próximo |
| | ▲ | volta para a barra |
| Sempre | RETURN / STOP | fecha a camada aberta; sem camada, para e volta para a tela de origem |
| | AMARELO | Áudio e legendas (atalho de hoje) |
| | FF / REW | +85 s / −85 s (como hoje) |

A HUD some 4 s depois se o vídeo estiver tocando e fica na tela se estiver pausado (regra atual do `PlayerHud`).

### 1.3 Barra de progresso

- Tempo atual à esquerda e **tempo restante** à direita (`−12:49`), no lugar do total.
- Buffer (`setBuffered`, já existe), preenchimento vermelho e marcador redondo.
- **Marca de créditos**, com o rótulo "créditos" acima: posição dada por `creditsStart()` (`app.js:2207`). Só aparece quando há dado real no `skip.json` (`ed` ou `cr`). Com o valor padrão de "45 s antes do fim" a marca não aparece, para não mentir.

### 1.4 Avançando (tela 9)

- `Scrub.step` guarda o ponto de partida. `UI.showScrub(alvo, partida)` desenha:
  - o balão branco acima do marcador, com o tempo-alvo grande e o selo vermelho com a diferença (`+4:28` / `−1:10`);
  - o trecho pulado em branco 60% entre a partida e o alvo;
  - o marcador maior.
- O balão não sai da tela: a posição é limitada às bordas.
- A linha de dica fica embaixo: "◀ ▶ segure para acelerar (10 s → 30 s → 1 min) · solte: vai para 14:30".
- Confirma ao soltar a tecla ou depois de 900 ms (como hoje).

### 1.5 Pular abertura (tela 10)

- Botão branco no canto inferior direito, com o texto "Pular abertura" ou "Pular encerramento", o selo **OK** e uma barrinha do tempo que falta: largura = (agora − início) / (fim − início).
- Embaixo, a dica "some sozinho quando a abertura acabar".
- Regras atuais mantidas (`updateSkip`, `doSkip`): aparece mesmo com a HUD escondida, OK pula, e o trecho pulado não volta a aparecer.

### 1.6 Próximo episódio nos créditos (tela 12)

- Card de 620px acima dos controles, com:
  - miniatura do próximo episódio (`ThumbsFolder`) e o número grande;
  - "PRÓXIMO EPISÓDIO", o título (TMDB a partir da fase 2; antes disso, "Episódio 8") e "23 min · pronto para tocar";
  - o botão branco "Assistir agora" e a dica "OK para assistir · ▲ para ocultar · no fim, começa sozinho em 5 s".
- Regras atuais mantidas (`updateCredits`): aparece no início dos créditos, OK assiste, ▲ oculta, e no fim a contagem de 5 s aparece com o anel dentro do botão.
- Inclui a próxima temporada, como hoje (`findNextSeason`).

### 1.7 Áudio e legendas (tela 11)

- Painel lateral direito de 680px, fundo `--surface`, com as seções "Áudio" e "Legendas". Cada linha tem 64px, ✓ na escolha atual e uma linha de explicação:
  - áudio: "Dublado" ou "Original" (pelo rótulo da faixa e pelo idioma original do título no TMDB a partir da fase 2);
  - legenda forçada: "Forçada · aparece mesmo com legendas desligadas";
  - legenda de arquivo: "Arquivo .srt".
- ▲▼ percorrem as duas listas como uma coluna só; OK escolhe; RETURN ou AMARELO fecham.
- **Pausa ao abrir e volta a tocar ao fechar** (decisão D1).
- **Preferência por série:** "A escolha vale para os próximos episódios desta série". Hoje o `PrefStore` guarda o idioma de forma global.
  - Passa a guardar `faixas:<série>` e usa a preferência global como reserva.
  - Muda em `applyTrackPrefs` (`app.js:827`) e onde `selectAudio`/`selectText` gravam a escolha.

### 1.8 Episódios dentro do player

- O botão "Episódios" abre um **painel inferior por cima do vídeo** (decisão D2), em vez de sair do player. O painel tem a fileira de cards do mesmo componente da página da série, com o episódio atual marcado com anel vermelho e "assistindo agora".
- OK em outro episódio salva o atual e abre o escolhido no ponto salvo dele (`savedPosition`). RETURN fecha.
- Na fase 1, o painel mostra os episódios da pasta atual (`App.playlist`). O seletor de temporada entra depois da fase 2.

### 1.9 Retomando (tela 7)

- **Gancho no Player**, sem mudar a lógica: `Player.onResume(ev)` é chamado em `beginResume` (`app.js:453`), `resumeOk` (`:502`) e `resumeFailed` (`:526`), com `{ estado: 'inicio'|'nova-tentativa'|'ok'|'desistiu', passo, total, alvo }`.
- A sobreposição só aparece se a confirmação demorar **mais de 800 ms**. Retomada rápida não pisca na tela.
- Conteúdo:
  - anel girando (só `transform`, que é leve);
  - "Death Parade · T1 E7" e "Voltando para 10:02";
  - mini barra com o ponto marcado;
  - "Seu ponto fica salvo mesmo se demorar."
- Em nova tentativa, a linha muda para "Tentando de outro jeito (2 de 3)…" e substitui o toast "Retomando de outro jeito...".
- **"Começar do início"** (com foco) chama um `Player.restart()` novo: cancela o plano, zera o `resumeGuard` (é escolha sua) e abre do zero.
- **RETURN** cancela e volta, com o ponto preservado: `saveProgress` já não grava durante a retomada.
- **Desistiu:** mostra "Não consegui voltar para 10:02" com "Começar do início" e "Tentar de novo". Se você não escolher nada em 5 s, começa do início sozinho e preserva o ponto, como hoje (decisão D4).
- O spinner comum fica escondido enquanto a sobreposição estiver na tela.

### 1.10 Títulos no player

- Série: "Death Parade · Temporada 1" + "Episódio 7". A partir da fase 2: "E7 · <título do episódio>".
- Filme: "Filme · 2025" + nome limpo (`cleanName`).

### Pronto quando (roteiro na TV)

- [ ] Episódio novo: a HUD aparece e some em 4 s; pausado, fica.
- [ ] ◀▶ com toque = ±10 s. Segurado: acelera com balão e diferença, e ao soltar vai para o ponto.
- [ ] ▼ foca o Play; ◀▶ percorre os 6 botões, e cada um faz a sua ação.
- [ ] A marca de créditos aparece só nos episódios com `ed`/`cr` no `skip.json`.
- [ ] Pular abertura no FMA:B: a barrinha anda e o botão some quando a abertura acaba.
- [ ] Card de próximo episódio nos créditos: ▲ oculta, OK assiste, e no fim a contagem de 5 s funciona.
- [ ] Áudio e legendas: troca de faixa, `.srt` e forçada. A escolha vale para o próximo episódio da mesma série e não muda outra série.
- [ ] Retomada rápida sem sobreposição. Retomada lenta com o tempo certo, "Começar do início" funcionando e RETURN sem perder o ponto.
- [ ] **Death Parade E7 e Lanternas S01E08 retomam no ponto** (teste do `e210a79` que ainda está pendente).
- [ ] O vídeo continua visível o tempo todo (nenhum fundo opaco por engano).

---

## Fase 2 — Dados: metadados e biblioteca (tamanho G)

O Início, a página da série e a Biblioteca precisam de sinopse, ano, gêneros, títulos de episódio e uma arte 16:9 de fundo. Hoje o HD tem só capas (`thumbs/`).

### 2.1 Script no PC: `metadados.ps1` (novo)

Saída no HD:

```
AmorecoFlix/meta/biblioteca.json
AmorecoFlix/meta/fundos/<pasta do título>.jpg    fundo 16:9 (TMDB w1280, ~150–250 KB)
AmorecoFlix/meta/posters/<arquivo do filme>.jpg  pôster 2:3 (w342), só para filmes soltos
AmorecoFlix/meta/ids.json                        correções manuais de ID (opcional)
```

Formato do `biblioteca.json` (a chave é o caminho relativo à biblioteca, o mesmo padrão do `progresso.json`):

```json
{
  "versao": 1,
  "gerado": "2026-10-12T20:00:00",
  "titulos": {
    "Animes/Death Parade": {
      "tipo": "anime", "tmdb": 12345, "titulo": "Death Parade", "ano": 2015,
      "generos": ["Animação", "Mistério"], "sinopse": "…",
      "idioma": "ja", "fundo": "fundos/Death Parade.jpg",
      "temporadas": { "1": { "episodios": { "7": { "titulo": "…", "sinopse": "…", "min": 23 } } } }
    },
    "Filmes/Anaconda (2025) [1080p].mkv": {
      "tipo": "filme", "tmdb": 0, "titulo": "Anaconda", "ano": 2025, "min": 99,
      "sinopse": "…", "fundo": "fundos/Anaconda (2025) [1080p].jpg", "poster": "posters/Anaconda (2025) [1080p].jpg"
    },
    "Filmes/Vingadores": { "tipo": "colecao", "tmdb": 0, "titulo": "Vingadores", "fundo": "…" }
  }
}
```

- **Reaproveitar as buscas que já funcionam** (`posters-pastas.ps1`, `posters-filmes.ps1`, `capas-temporada.ps1`): mover para o `lib.ps1` como `Find-TmdbTv`, `Find-TmdbMovie` e `Find-TmdbCollection`. Os três scripts passam a usar essas funções.
- **Episódio ↔ arquivo:** temporada pelo nome da pasta (mesma regra do `seasonNumber`) e número do episódio pelo nome do arquivo (mesma regra do `epInfo`: `S01E07`, `Episódio 07`, `1x07`).
- **Incremental:** só busca o que falta no JSON (`-Force` refaz tudo; `-Only "<título>"` refaz um). Títulos removidos do HD saem do JSON.
- **Correções manuais:** `meta/ids.json` (ex.: `{ "Animes/Death Parade": 12345 }`) para quando o TMDB errar o título.
- No fim, imprime **relatório**: encontrados, não encontrados e episódios sem título.
- Roda sozinho no fim do `import-serie.ps1` e do Importador (`-Only` com o título importado).
- Aceita o mesmo modo `-ApiUrl` dos outros scripts, para gravar pela rede com o HD na TV.

### 2.2 App: módulo `Meta` (`js/library.js`)

- Lê `meta/biblioteca.json` no `scanUsb`, igual ao `SkipData`.
- Oferece `Meta.title(chave)`, `Meta.episode(chave, temporada, episódio)`, `Meta.backdrop(chave)` e `Meta.poster(chave)`.
- A URI da imagem é montada como `'file://' + libraryDir.fullPath + '/meta/' + arquivo`.
- `HIDDEN_DIRS` ganha `meta`.
- **Sem o JSON, tudo continua funcionando:** nomes limpos (`cleanName`), fundo em bloco de cor e "Episódio N".

### 2.3 App: módulo `Library` (`js/library.js`)

- `Library.scan(libraryDir)` percorre `Series/`, `Animes/` e `Filmes/`:
  - série/anime com subpastas de temporada → temporadas; pasta plana (Death Parade, Lanternas) → temporada 1;
  - `Filmes/arquivo` → filme; `Filmes/pasta` → coleção.
- Episódios de cada temporada: `listDirectory` em segundo plano, **duas pastas por vez**, com a tela atualizando aos poucos.
- Objeto de título:

  ```js
  { key: 'Animes/Death Parade', kind: 'anime', name: 'Death Parade', dir: File,
    seasons: [{ num: 1, name: 'Death Parade', dir: File, eps: [entry, ...] }],
    file: null /* filme */, added: Date /* arquivo mais novo */ }
  ```

- **Cache no localStorage**, só com nomes e datas, sem objetos `File`: o Início e a Biblioteca aparecem na hora no boot e se ajustam quando a leitura do HD termina.
- Consultas, cruzando com o `ProgressStore`:
  - `progressOf(título)` → `{ vistos, total, atual: { entry, rec }, proximo: entry, pct }`;
  - `continueItems()`: a lista atual, agrupada por série (`dedupeContinueBySeries` já faz isso);
  - `nextUpItems()` → **Próximos episódios**: você terminou o episódio N, o N+1 existe e ainda não foi começado; ordenado pelo mais recente;
  - `isNew(título)` → **NOVO EP**: episódio com data de arquivo mais nova que a última vez que você assistiu a série, e ainda não visto.
- Com a `Library` pronta, `findNextEpisode` e `findNextSeason` passam a consultá-la, sem busca assíncrona; o código atual fica como reserva.
- **Atualização:** VERMELHO, troca de HD (listener que já existe) e fim de um recebimento pela rede (`NetUpload`, em `app.js:3453`) → `Library.refresh(chave do título)`.

### 2.4 `ProgressStore`: funções novas

- `listUnder(prefixo)`: registros de um título. As chaves já são relativas (`Series/...`), então basta comparar o prefixo.
- `setDone(caminho, visto)`: marca como visto **criando o registro se não existir**. Hoje `markComplete` só altera um registro que já existe.
- `hide(caminho)`: "Tirar de Continuar assistindo" passa a **esconder** o item em vez de apagar o ponto (`remove` apaga hoje). Assistir de novo traz o item de volta.

**Pronto quando:**

- o `biblioteca.json` cobre todos os títulos atuais (9 séries/animes, 8 coleções, ~32 filmes), e o relatório lista o que faltou;
- no app, o log mostra `[library] N títulos, M episódios em X ms`, e o tempo fica abaixo de ~2 s na TV;
- sem o JSON, o app continua funcionando.

---

## Fase 3 — Início, Opções e Sem HD (tamanho M)

Telas 1, 5 e 6 do protótipo.

### 3.1 Estrutura

- `#topbar` compartilhado por Início, Biblioteca e Pastas: logo, abas **Início · Biblioteca · Pastas** e o indicador do HD (verde "HD conectado" ou vermelho "Nenhum HD").
- `#screen-home`: destaque, fileira "Continuar assistindo" e fileira "Próximos episódios". Ao focar a 2ª fileira, a tela sobe (`translateY`).

### 3.2 Destaque

- Mostra o item mais recente de Continuar. Sem nenhum, um título recém-adicionado ou não começado.
- Fundo: `Meta.backdrop`. Reservas: a capa da pasta (`thumbs/<pasta>.jpg`) com degradê e, por último, um bloco de cor.
- Conteúdo:
  - linha de dados ("ANIME · 2015 · 1 TEMPORADA"), título e sinopse em até 3 linhas;
  - "Episódio 7 · 12 min restantes" com a barra;
  - botões "Continuar E7" (retomada) e "Episódios e detalhes" (página da série).
- **Destaque fixo (D6, decidido):** mostra sempre o item mais recente e não muda quando o foco anda pela fileira. A troca pelo card focado fica fora do escopo; se um dia for feita, terá espera de 500 ms parado e transição de 300 ms.

### 3.3 Fileiras

- **Continuar assistindo:** cards de 400×225 com o still do episódio (`ThumbsFolder`), selo "T1 E7", título da série, barra e "12 min restantes". No card focado, "segure OK p/ opções". OK abre a retomada e segurar OK abre Opções.
- **Próximos episódios:** `Library.nextUpItems()`, com "T1 E8 · novo episódio" na legenda. OK abre do início. A fileira some se estiver vazia.

### 3.4 Abas

- ▲ a partir do destaque sobe para as abas. ◀▶ mudam a aba destacada e **OK abre** a tela; só passar por cima não carrega nada.

### 3.5 Opções (tela 5), substitui `ContextMenu`

- Fundo escurecido a 70% e uma caixa central de 760px, com a miniatura, o título e "T1 E7 · parou em 10:02 · 12 min restantes".
- Ações:
  - **Continuar de 10:02**
  - **Começar o episódio do início**
  - **Ver episódios** (página da série)
  - **Marcar como assistido** (`setDone`; o item sai de Continuar e o próximo aparece em Próximos)
  - **Tirar de Continuar assistindo** (`hide`)
- ▲▼ escolhem, OK confirma e RETURN fecha.
- O mesmo diálogo, com outras ações, serve para episódios na página da série e para títulos na Biblioteca.

### 3.6 Sem HD (tela 6)

- Tela própria quando não há HD (`mapUsb` vazio) ou quando falta a pasta AmorecoFlix, com uma mensagem diferente para cada caso.
- Botão "Procurar de novo" (OK) e tecla VERMELHO. A tela sai sozinha quando o HD aparece (o listener já existe).

### 3.7 Boot

- O Início aparece **na hora**, com o cache da `Library` e o progresso local, e se atualiza quando a leitura do HD termina. O app passa a abrir no Início (D3); hoje abre nas pastas.

**Pronto quando:**

- o Início aparece em menos de 1,5 s com o Continuar preenchido;
- RETURN no player volta ao card de onde você saiu, com foco nele;
- segurar OK abre Opções, e "Marcar como assistido" tira o item de Continuar e coloca o próximo em Próximos;
- sem HD, aparece a tela certa, e ao conectar o HD a biblioteca aparece sozinha.

---

## Fase 4 — Página da série, do filme e da coleção (tamanho M)

Tela 2 do protótipo.

### 4.1 Layout

- Fundo (`Meta.backdrop`) com degradês à esquerda e embaixo. No topo, "‹ Voltar" e o logo.
- Coluna esquerda:
  - linha de dados, título e sinopse;
  - chips: qualidade (pela altura do vídeo no `ContentIndex` ou pela tag `[1080p]` no nome), "Pular abertura" (se algum episódio tiver `op` no `skip.json`) e "6 de 12 assistidos";
  - botões, conforme 4.2.
- Embaixo: "Episódios", o seletor "Temporada 1 ⌄" e a fileira de episódios.

### 4.2 Regras do botão principal

| Situação | Botão |
|---|---|
| episódio em andamento | "Continuar E7 · 12 min" |
| nada em andamento, próximo ainda não visto | "Assistir E8" (ou "Assistir T2 E1") |
| nada visto | "Assistir E1" |
| tudo visto | "Assistir de novo" |

- "Do início": o episódio atual desde o zero.
- ✓: marca ou desmarca a temporada inteira, com aviso "Temporada 1 marcada como vista". Apertar de novo desfaz.

### 4.3 Episódios

- Seletor de temporada: OK abre uma lista curta ("Temporada 1 · 22 ep · vista").
- Cards de 360×203 com:
  - still e número grande ("07");
  - ✓ nos vistos (com a arte mais apagada) e barra de progresso;
  - título do TMDB ("Episódio 7" sem metadados);
  - legenda: "23 min · Assistido", "Você parou aqui · 12 min restantes" (em vermelho) ou só a duração.
- O episódio atual tem anel vermelho, e **a fileira já abre rolada até ele**.
- OK abre o episódio no ponto salvo dele. Segurar OK abre Opções do episódio (Assistir, Do início, Marcar como assistido/não assistido).
- Opcional: a sinopse do episódio focado aparece acima da fileira.

### 4.4 Variações

- **Filme:** sem fileira de episódios; botões "Continuar · 40 min" ou "Assistir", "Do início" e ✓.
- **Coleção** (Filmes/Vingadores...): fileira "Filmes" com os filmes da pasta, por ano quando houver metadado.
- O foco inicial fica no botão principal.

**Pronto quando:** The Vampire Diaries abre na temporada certa; trocar de temporada funciona; marcar a temporada atualiza o ✓ e o contador; voltar mantém o foco.

---

## Fase 5 — Biblioteca (tamanho M)

Tela 3 do protótipo.

- Título "Biblioteca" e os chips **Tudo / Séries / Animes / Filmes** | **Em andamento / Não começadas** | **Recém-adicionados**.
  - Tipo e estado se combinam; "Recém-adicionados" é uma ordenação.
  - O filtro escolhido fica lembrado (`PrefStore`).
- Grade de **6 colunas** de pôsteres 2:3 (~262×393). Cada pôster tem:
  - barra de progresso na base e selo **NOVO EP**;
  - nome embaixo;
  - legenda: "Anime · 6 de 12 vistos", "Série · 8 temporadas" ou "Filme · 2 h 19 min".
- Pôsteres:
  - séries e coleções: `thumbs/<pasta>.jpg`, que já são pôsteres do TMDB;
  - filmes: `meta/posters/<arquivo>.jpg` (fase 2);
  - reservas: a thumb 16:9 recortada e, por último, um bloco de cor com o nome.
- Ordem padrão: em andamento primeiro (pelo mais recente), depois alfabética.
- Navegação: ▲ da 1ª linha vai para os chips e ▲ dos chips vai para as abas. A grade rola linha a linha (`translateY`), e as imagens carregam só para a linha visível e as vizinhas.
- OK abre a página do título. Segurar OK abre Opções (Ver episódios, Marcar série como vista, Tirar de Continuar).

**Pronto quando:** os ~50 títulos aparecem, os filtros combinam, a rolagem fica fluida na TV e o selo NOVO EP aparece num episódio recém-copiado.

---

## Fase 6 — Pastas (tamanho P)

Tela 4 do protótipo.

- Mesma lógica de hoje (`enterDirectory`, `goUpDirectory`, `renderFileList`), com visual novo:
  - caminho no topo ("AmorecoFlix › Series › The Vampire Diaries");
  - cards 16:9 de 420×236, 4 por linha;
  - pastas de temporada com a capa do `capas-temporada.ps1`, que **já traz a faixa "Nª TEMPORADA" na imagem**. A faixa em HTML só aparece quando falta a imagem.
- Pasta toda vista: ✓ e arte mais apagada. Legenda "22 episódios · assistida" ou "em andamento (E2)", via `Library`.
- Arquivos: o mesmo card 16:9 com still, selo e barra.
- Barra de dicas: OK abrir · RETURN pasta anterior · VERMELHO procurar o HD · AZUL rede · VERDE debug.
- Continua sendo o "modo avançado": tudo que está no HD fica acessível, inclusive o que não se encaixa na Biblioteca.

---

## Fase 7 — Polimento (tamanho P)

- **Animações** só com `transform` e `opacity`: foco em 120 ms, troca de tela em 150 ms, painéis em 200 ms.
- **Desempenho:** registrar no log os tempos de boot, troca de tela e abertura do player. No máximo 2–3 fundos grandes carregados; o `src` é liberado ao sair da tela.
- **Textos com acento em todo o app.** Hoje há "Proximo episodio", "Nao consegui" etc. Os arquivos são UTF-8, então funciona.
- **Limpeza:** remover `#ctx-menu`, `#next-toast`, `#p-settings`, a `hint-bar` antiga e o CSS sem uso.
- **Documentação:** telas e teclas no README; versão `2.0.0` no `config.xml`; atualizar a memória do projeto.

---

## 3. Mapa de teclas (versão final)

| Tecla | Início / Biblioteca / Pastas / Série | Player |
|---|---|---|
| ◀▶▲▼ | move o foco | barra: avançar/voltar · botões: mover |
| OK | abrir / assistir | barra: play/pausa · botão: ação · Pular abertura |
| Segurar OK | Opções do card | — |
| RETURN | tela anterior / pasta anterior | fecha a camada; senão, para e volta |
| VERMELHO | procurar o HD de novo | — |
| VERDE | console de debug | console de debug |
| AZUL | status da rede (NetUpload) | — |
| AMARELO | — | Áudio e legendas |
| PLAY/PAUSE | — | play/pausa |
| FF / REW | — | +85 s / −85 s |
| STOP | — | para e volta |

---

## 4. Testes

**Simulador** (`tools/simulador/`, fase 0):

- mock do `tizen.filesystem` com a estrutura real do HD (séries com temporadas, anime plano, filmes e coleções), `biblioteca.json`, `skip.json` e faixas de áudio/legenda;
- cada fase é conferida no navegador em 1920×1080, com capturas comparadas às telas do protótipo;
- roteiro de teclas por tela, para garantir que o foco nunca "some".

**TV** (só com autorização, uma vez por fase): roteiro "Pronto quando" da fase e consulta ao `amorecoflix.log` com os tempos medidos.

**Regressão em toda instalação:**

- [ ] Retomada: Death Parade E7 e Lanternas S01E08
- [ ] Progresso gravado no HD (`progresso.json`) e sobrevivendo a reinstalação
- [ ] NetUpload (receber arquivo pela rede)
- [ ] Próxima temporada (último episódio → T+1 E1)
- [ ] Legendas externas e forçadas
- [ ] Pular abertura (FMA:B) e créditos detectados

---

## 5. Riscos

| Risco | Como evitar |
|---|---|
| Algum CSS do protótipo não funcionar na TV | Teste de recursos na fase 0 (`CSS.supports` no log), com alternativas antes de construir as telas |
| Fundos grandes deixando a TV lenta | JPG w1280 com qualidade ~80, no máximo 2–3 na memória, sem `blur` |
| Mais telas = mais lugares para o foco se perder | Nav v2 com grupos declarados e roteiro de teclas no simulador |
| TMDB escolher o título errado | `meta/ids.json` com correções manuais e relatório do script |
| Regressão na retomada | A fase 1 não toca na lógica do Player, só acrescenta o gancho; teste dos 2 episódios problemáticos |
| Arquivo novo fora do `.wgt` | Checagem no `build.ps1` (fase 0) |

---

## 6. Ordem de execução

| Fase | Entrega | Depende de | Tamanho | Na TV? |
|---|---|---|---|---|
| 0 | Base: tokens, fontes, router, Nav v2, build, simulador | — | M | sim (sem mudança visível) |
| 1 | Player: 6 estados | 0 | G | sim |
| 2 | Dados: `metadados.ps1`, Meta, Library | 0 | G | script roda no PC |
| 3 | Início + Opções + Sem HD | 2 | M | sim |
| 4 | Página da série/filme/coleção | 2, 3 | M | sim |
| 5 | Biblioteca | 2, 3 | M | sim |
| 6 | Pastas | 0, 2 | P | sim |
| 7 | Polimento | todas | P | sim |

As fases 1 e 2 são independentes e podem andar em paralelo.

**Fluxo de trabalho:** branch `redesign`, um commit por etapa, merge no `master` ao fim de cada fase, depois do teste na TV.

---

## 7. Decisões em aberto (com a recomendação)

| # | Pergunta | Recomendação |
|---|---|---|
| D1 | Pausar o vídeo ao abrir Áudio e legendas / Episódios? | ✅ **Decidido: pausa os dois** e volta a tocar ao fechar (se estava tocando) |
| D2 | "Episódios" no player: painel por cima do vídeo ou sair para a página da série? ✅ **Decidido: painel por cima** do vídeo pausado |
| D3 | Tela ao abrir o app ✅ **Decidido: Início** |
| D4 | Retomada que desistiu ✅ **Decidido: perguntar** (Começar do início / Tentar de novo) e, sem escolha em 5 s, começar do início |
| D5 | Fontes Sora/Figtree embutidas no app (+~150 KB) ou fontes do sistema? ✅ **Decidido: embutir** (baixar os .woff2 com autorização na fase 0) |
| D6 | Destaque do Início acompanhando o card focado | ✅ **Decidido: destaque fixo** (opção A, 12/10/2026) |
| D7 | Separar o `app.js` em arquivos (`js/...`) | ✅ **Decidido: separar** |
| D8 | Preferência de áudio/legenda por série ✅ **Decidido: por série**, com a global como reserva |
