/* ============================================================================
 * Meu Player USB  -  app.js
 * Reprodutor autonomo para Samsung Smart TV (Tizen) via sideload.
 *
 * Tres pilares (secoes 1, 2 e 3 abaixo):
 *   1. mapUsb()      -> mapeia o HD/pendrive via tizen.filesystem
 *   2. Player        -> inicializa e controla o webapis.avplay (AVPlay)
 *   3. ProgressStore -> salva/recupera progresso e historico no localStorage
 *
 * O restante do arquivo (secoes 4-6) e a camada de UI e navegacao por D-pad.
 * ==========================================================================*/

'use strict';

/* ============================================================================
 * 0. CONSOLE DE DEBUG NA TELA  (tecla VERDE)
 *    A TV de varejo bloqueia dlog/Web Inspector via sdb, entao capturamos
 *    console.log/warn/error e mostramos num painel na propria tela.
 * ==========================================================================*/
var DebugLog = (function () {
    var lines = [], box = null, visible = false;
    var unsaved = [], saving = false;          // linhas ainda nao gravadas no HD (ver persist)

    function fmt(a) {
        try { return (a && typeof a === 'object') ? JSON.stringify(a) : String(a); }
        catch (e) { return '' + a; }
    }
    function push(tag, args) {
        var t = new Date().toTimeString().slice(0, 8);
        var line = t + ' [' + tag + '] ' + Array.prototype.map.call(args, fmt).join(' ');
        lines.push(line);
        if (lines.length > 300) { lines.shift(); }
        unsaved.push(line);
        if (unsaved.length > 2000) { unsaved.splice(0, unsaved.length - 2000); }
        if (visible) { render(); }
    }
    unsaved.push('===== AmorecoFlix iniciado em ' + new Date().toLocaleString() + ' =====');
    ['log', 'info', 'warn', 'error'].forEach(function (k) {
        var orig = (console[k] || function () {});
        console[k] = function () { try { orig.apply(console, arguments); } catch (e) {}
                                   push(k.toUpperCase(), arguments); };
    });
    window.addEventListener('error', function (e) {
        push('JS-ERR', [(e.message || 'erro') + ' @ ' +
             (e.filename || '?').split('/').pop() + ':' + (e.lineno || '?')]);
    });
    function render() {
        if (!box) { return; }
        box.textContent = lines.slice(-60).join('\n');
        box.scrollTop = box.scrollHeight;
    }
    function toggle() {
        if (!box) { box = document.getElementById('dbg'); }
        visible = !visible;
        box.hidden = !visible;
        if (visible) { render(); }
    }

    /* Acrescenta as linhas novas em AmorecoFlix/amorecoflix.log no HD - a TV
     * de varejo bloqueia dlog/Web Inspector, entao e assim que da pra ver no
     * PC o que aconteceu (ex.: uma retomada que falhou). Chamado junto com a
     * gravacao do progresso (ProgressStore.flush). Passou de 512 KB, recomeca.
     * Extensao .log de proposito: o limpar-lixo.ps1 apaga .txt. Nada de
     * console.log aqui dentro (geraria linhas novas sem fim). */
    var LOG_FILE = 'amorecoflix.log', LOG_MAX = 512 * 1024;
    function persist() {
        if (saving || !unsaved.length || !window.tizen || !tizen.filesystem ||
            !window.App || !App.libraryDir || !App.libraryDir.fullPath) { return; }
        saving = true;
        var chunk = unsaved.join('\n') + '\n';
        unsaved = [];
        var dirPath = App.libraryDir.fullPath, path = dirPath + '/' + LOG_FILE;
        function done() { saving = false; }
        function append(f) {
            try {
                f.openStream('a', function (s) {
                    try { s.write(chunk); } catch (e) {}
                    try { s.close(); } catch (e) {}
                    done();
                }, done, 'UTF-8');
            } catch (e) { done(); }
        }
        function create(dir) { try { append(dir.createFile(LOG_FILE)); } catch (e) { done(); } }
        try {
            tizen.filesystem.resolve(path, function (f) {
                if (f.fileSize > LOG_MAX) {
                    tizen.filesystem.resolve(dirPath, function (dir) {
                        try { dir.deleteFile(f.fullPath, function () { create(dir); }, done); } catch (e) { done(); }
                    }, done, 'rw');
                } else {
                    append(f);
                }
            }, function () {
                tizen.filesystem.resolve(dirPath, create, done, 'rw');
            }, 'rw');
        } catch (e) { done(); }
    }

    return { toggle: toggle, persist: persist, isOpen: function () { return visible; } };
})();

/* Extensoes de video reconhecidas na navegacao. */
var VIDEO_EXT = ['mp4', 'mkv', 'avi', 'mov', 'm4v', 'ts', 'webm', 'wmv', 'flv',
                 'mpg', 'mpeg', '3gp', 'm2ts', 'vob', 'ogv'];

/* Considera "assistido" quando passou de 92% da duracao. */
var COMPLETE_RATIO = 0.92;

/* Pasta-raiz da biblioteca dentro do HD. Nada fora dela e mostrado.
 * (aqui no topo: o ProgressStore usa ao iniciar) */
var LIBRARY_DIR = 'AmorecoFlix';

/* Estado global simples da aplicacao. */
var App = {
    storages:     [],      // storages USB montados (tizen.filesystem)
    currentDir:   null,     // objeto File (diretorio) atual
    dirStack:     [],       // pilha de diretorios para o "voltar"
    libraryDir:   null,     // objeto File da pasta AmorecoFlix (raiz da biblioteca)
    dirSubs:      {},       // legendas externas por basename
    skip:         null,     // intervalos OP/ED do episodio atual
    skipDone:     {},       // {op:true} intervalos ja pulados
    tracks:       { audio: [], text: [] },   // faixas do video atual
    trackSel:     { audio: -1, text: -1 },   // -1 = nao definido / off
    extSubs:      [],       // todas as legendas externas: [{name,uri,lang,forced}]
    dirFiles:     [],       // conteudo listado do diretorio atual
    dirImages:    [],       // imagens da pasta (usadas como capa)
    playlist:     [],       // videos da pasta do episodio em reproducao (ordenados);
                            // so muda ao abrir um video, nunca ao navegar
    playingPath:  null,     // fullPath do video em reproducao
    nextEp:       null,     // proximo episodio do atual (card dos creditos)
    nextSeason:   null,     // { entry, list } 1o episodio da proxima temporada (outra pasta)
    usingAvplay:  false     // true = AVPlay, false = fallback <video>
};


/* ============================================================================
 * 1. MAPEAMENTO DO USB  (tizen.filesystem)
 * ==========================================================================*/

/**
 * Lista todos os storages e filtra os removiveis montados (HD/pendrive USB).
 * Em Tizen TV o HD costuma aparecer como label "removable/drive1", type "EXTERNAL".
 * @param {function(Array)} onDone  recebe a lista de storages USB montados
 */
function mapUsb(onDone) {
    App.storages = [];

    if (!window.tizen || !tizen.filesystem || !tizen.filesystem.listStorages) {
        console.warn('[USB] tizen.filesystem indisponivel (emulador/navegador).');
        onDone([]);
        return;
    }

    tizen.filesystem.listStorages(function (storages) {
        for (var i = 0; i < storages.length; i++) {
            var s = storages[i];
            var isRemovable = (s.type === 'EXTERNAL') ||
                              (s.label && s.label.indexOf('removable') === 0);
            var isMounted   = (s.state === 'MOUNTED');
            if (isRemovable && isMounted) {
                App.storages.push(s);
                console.log('[USB] montado:', s.label, '(' + s.type + ')');
            }
        }
        onDone(App.storages);
    }, function (err) {
        console.error('[USB] listStorages falhou:', err && err.message);
        onDone([]);
    });
}

/**
 * Resolve o label de um storage num objeto File (diretorio raiz navegavel).
 * @param {string} label   ex.: "removable/drive1"
 * @param {function(Object)} onSuccess  recebe o File do diretorio
 * @param {function(Error)}  onError
 */
function resolveStorage(label, onSuccess, onError) {
    tizen.filesystem.resolve(label, onSuccess, onError, 'r');
}

var IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];
function ext(name) {
    var d = name.lastIndexOf('.');
    return d < 0 ? '' : name.slice(d + 1).toLowerCase();
}
function isImageFile(name) { return IMG_EXT.indexOf(ext(name)) !== -1; }
function stripExt(name) { var d = name.lastIndexOf('.'); return d < 0 ? name : name.slice(0, d); }

/**
 * Lista o conteudo de um diretorio: pastas + videos (+ imagens usadas como capa).
 * @param {function(Array, Array)} onDone  (entries, images)
 */
/* pastas de sistema / auxiliares que nunca sao mostradas */
var HIDDEN_DIRS = ['thumbs', 'subs', 'legendas', '$recycle.bin', 'system volume information',
                   'found.000', '.trash', '@eadir'];

var SUB_EXT = ['srt', 'ass', 'ssa', 'vtt', 'sub'];
function isSubFile(name) { return SUB_EXT.indexOf(ext(name)) !== -1; }

function listDirectory(dir, onDone) {
    dir.listFiles(function (files) {
        var entries = [], images = [], subs = {};
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.name.indexOf('.') === 0) { continue; }          // ocultos
            if (f.isDirectory) {
                if (HIDDEN_DIRS.indexOf(f.name.toLowerCase()) !== -1) { continue; }
                entries.push({ file: f, name: f.name, isDir: true });
            } else if (isVideoFile(f.name)) {
                if (f.fileSize && f.fileSize < 8 * 1024 * 1024) { continue; } // promo/sample
                entries.push({ file: f, name: f.name, isDir: false, size: f.fileSize });
            } else if (isImageFile(f.name)) {
                images.push({ file: f, name: f.name, base: stripExt(f.name).toLowerCase() });
            } else if (isSubFile(f.name)) {
                // "Show S01E01.srt" ou "Show S01E01.pt.srt" -> chave "show s01e01"
                var b = stripExt(f.name).toLowerCase().replace(/\.(pt|pt-br|por|eng|en|forced|hi|sdh)$/i, '');
                (subs[b] = subs[b] || []).push({ file: f, name: f.name });
            }
        }
        entries.sort(compareEntries);
        onDone(entries, images, subs);
    }, function (err) {
        console.error('[FS] listFiles falhou:', err && err.message);
        onDone([], [], {});
    });
}

function isVideoFile(name) { return VIDEO_EXT.indexOf(ext(name)) !== -1; }

/* Ordenacao natural: "S01E02" antes de "S01E10". */
function compareEntries(a, b) {
    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
    return naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
}
function naturalCompare(a, b) {
    var ax = [], bx = [];
    a.replace(/(\d+)|(\D+)/g, function (_, n, s) { ax.push([n || Infinity, s || '']); });
    b.replace(/(\d+)|(\D+)/g, function (_, n, s) { bx.push([n || Infinity, s || '']); });
    while (ax.length && bx.length) {
        var an = ax.shift(), bn = bx.shift();
        var cmp = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
        if (cmp) { return cmp; }
    }
    return ax.length - bx.length;
}


/* ============================================================================
 * 2. PLAYER  (webapis.avplay  +  fallback <video> para o emulador)
 * ==========================================================================*/

var Player = (function () {

    var avplay      = (window.webapis && webapis.avplay) ? webapis.avplay : null;
    var html5       = document.getElementById('html5-player');
    var objEl       = document.getElementById('av-player');
    var duration    = 0;          // ms
    var position    = 0;          // ms
    var resumeMs    = 0;          // ponto de retomada solicitado
    var isPaused    = false;
    var tickTimer   = null;
    var onEndedCb   = null;
    var currentUri  = '';         // uri do arquivo em reproducao (p/ reabrir em travamento)

    /* deteccao de travamento ("congelou do nada") */
    var lastPlayMs    = 0;        // ultima posicao vista pelo detector
    var stallSince    = 0;        // Date.now da 1a deteccao de travamento (0 = ok)
    var stallStep     = 0;        // etapa da recuperacao ja tentada

    /* o AVPlay as vezes devolve duration/posicao "estourados" (uint32 -1 =
     * 4294967295ms, mesma pegadinha ja vista no duration do tizen.content.find)
     * depois de um erro/travamento. Sem essa guarda, a retomada automatica
     * tenta um seekTo() com esse valor, que o player recusa
     * (PLAYER_ERROR_SEEK_FAILED / InvalidValuesError) - e cada reabertura
     * seguinte cai na mesma retomada invalida e falha de novo. */
    function validMs(ms) { return typeof ms === 'number' && ms > 0 && ms < 4294967000; }
    var reopenCount   = 0;        // quantas vezes reabrimos este arquivo
    var seekingUntil  = 0;        // Date.now ate quando um seek esta em andamento (nao e travamento)
    var seekTarget    = 0;        // alvo do seek em andamento (ms); zerado quando o playtime chega nele
    var lastPlayedMs  = 0;        // ultima posicao REAL reportada pelo AVPlay (position e otimista no seek)

    /* --- inicializacao --- */

    function init() {
        App.usingAvplay = !!avplay;
        if (App.usingAvplay) {
            console.log('[Player] AVPlay disponivel.');
        } else {
            console.warn('[Player] AVPlay ausente. Usando <video> HTML5.');
            objEl.classList.add('hidden');
            html5.classList.remove('hidden');
            bindHtml5Events();
        }
    }

    /**
     * Abre e prepara um video, retomando de resumeFromMs (se > 0).
     * @param {string} fileUri   ex.: file.toURI()  ->  "file:///opt/media/..."
     * @param {number} resumeFromMs
     * @param {function} onEnded  chamado quando o video termina
     */
    function load(fileUri, resumeFromMs, onEnded) {
        resumeMs  = resumeFromMs || 0;
        resumeGuard   = 0;
        resumeAttempt = null;
        resumePlan    = null;
        onEndedCb = onEnded || null;
        position  = 0;
        duration  = 0;
        isPaused  = false;
        reopenCount = 0;
        stallSince  = 0;
        stallStep   = 0;
        seekTarget  = 0;
        seekingUntil = 0;
        if (validMs(resumeMs) && resumeMs >= 1000) {
            console.log('[Player] abrindo com retomada em', fmtTime(resumeMs));
            resumePlan = buildPlan(resumeMs, -1);
        }

        if (App.usingAvplay) {
            loadAvplay(fileUri);
        } else {
            html5.src = fileUri;
            html5.load();
        }
    }

    var watchdog    = null;   // timeout de "loading travado"
    var started     = false;  // ja recebeu o 1o frame/playtime NESTA abertura do player?

    function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

    var resumeSeekWatchdog = null;   // checagem periodica da retomada (ver checkResumeTimeout)
    function clearResumeWatchdog() {
        if (resumeSeekWatchdog) { clearTimeout(resumeSeekWatchdog); resumeSeekWatchdog = null; }
    }

    /* --- retomada ("Continuar assistindo") ---
     * Visto na TV (log no HD, Out/2026): pedir o seek e chamar play() logo em
     * seguida - sem esperar o seek terminar - deixa o AVPlay em "PLAYING"
     * PARADO no quadro do ponto salvo, em qualquer arquivo e ponto (Death
     * Parade E7, Lanternas S01E08; os dois decodificam sem erro no PC). Daqui
     * pra frente todo seek nesse player falha (PLAYER_ERROR_SEEK_FAILED) e so
     * reabrir resolve. Comecar do zero sempre funcionou.
     *
     * Entao cada tentativa usa um player recem-aberto e um de dois METODOS:
     *   'ready'   : seek no estado READY e play() SO depois do callback de
     *               sucesso do seek (ou do buffer pronto; 8 s sem nenhum dos
     *               dois -> play assim mesmo);
     *   'playing' : play() primeiro, espera o video ANDAR e ai pede o seek.
     * Plano: metodo preferido no alvo -> o outro metodo no alvo -> o outro 20 s
     * antes -> desiste e toca do inicio (ponto salvo preservado: resumeGuard).
     * O metodo que funcionar vira o preferido (PrefStore 'resumeMethod').
     * Confirmacao: o playtime chega perto do alvo E anda (+1 s). Chegou e nao
     * andou em 8 s = congelado -> proxima tentativa. Prazos conferidos nos
     * eventos do player, num setTimeout de 2 s, no tick e a cada tecla.
     * Enquanto isso nada e gravado e os botoes "Pular abertura"/"Proximo
     * episodio" nao aparecem. O mesmo plano, para FRENTE (dir +1), pula um
     * trecho onde o video travou no meio (ver checkStall). */
    var RESUME_TIMEOUT       = 40000;  // prazo total de uma tentativa
    var RESUME_NEAR          = 12000;  // playtime ate 12 s antes do alvo (keyframe) = chegou
    var RESUME_FROZEN        = 8000;   // chegou no alvo e nao andou por 8 s = congelado
    var RESUME_PLAY_FALLBACK = 8000;   // metodo 'ready': sem callback/buffer em 8 s -> play mesmo assim
    var RESUME_IGNORED_TOL   = 12000;  // video tocando longe do alvo por 12 s (de midia) = seek ignorado
    var resumeGuard   = 0;      // ponto salvo a proteger enquanto a retomada nao confirmou
    var resumeAttempt = null;   // tentativa em andamento (ver beginResume)
    var resumePlan    = null;   // [{ m, at }] + .step/.dir/.target (ver buildPlan)
    var loadGen       = 0;      // descarta callbacks de uma abertura anterior

    function avState() { try { return avplay.getState(); } catch (e) { return '?'; } }
    function methodName(m) { return m === 'ready' ? 'seek antes do play' : 'play antes do seek'; }
    function preferredMethod() { return PrefStore.get('resumeMethod') === 'playing' ? 'playing' : 'ready'; }

    /* tentativas em ordem; cada uma num player recem-aberto */
    function buildPlan(target, dir) {
        var a = preferredMethod(), b = (a === 'ready') ? 'playing' : 'ready';
        // retomada: o problema costuma ser o METODO -> troca o metodo no mesmo ponto.
        // travou no meio (dir +1): o metodo ja e conhecido, o problema costuma ser
        // o TRECHO -> mesmo ponto 1x (travada passageira) e depois para frente.
        var plan = (dir > 0)
            ? [{ m: a, at: target }, { m: a, at: target + 15000 }, { m: b, at: target + 30000 }]
            : [{ m: a, at: target }, { m: b, at: target }, { m: b, at: Math.max(1000, target - 20000) }];
        plan.dir = dir > 0 ? 1 : -1;
        plan.target = target;
        plan.step = 0;
        return plan;
    }

    /* reabre o arquivo e vai para ms (dir -1 = retomada, +1 = pular trecho) */
    function reopenAt(ms, dir, why) {
        resumeMs   = ms;
        resumePlan = buildPlan(ms, dir);
        console.warn('[Player] ' + why + '; reabrindo em ' + fmtTime(ms));
        loadAvplay(currentUri);
    }

    function nearResume(r, ms) { return ms >= r.ms - RESUME_NEAR && ms <= r.ms + 15000; }

    function armResumeWatchdog() {
        clearResumeWatchdog();
        resumeSeekWatchdog = setTimeout(function () {
            resumeSeekWatchdog = null;
            checkResumeTimeout();
            if (resumeAttempt && !resumeSeekWatchdog) { armResumeWatchdog(); }
        }, 2000);
    }

    /* prazos da tentativa (relogio): chamado nos eventos do player, no
     * watchdog acima, no tick e a cada tecla - o que vier primeiro */
    function checkResumeTimeout() {
        var r = resumeAttempt;
        if (!r) { return; }
        var now = Date.now();
        if (r.m === 'ready' && !r.played && now - r.at > RESUME_PLAY_FALLBACK) {
            console.warn('[Player] seek sem callback em ' + (RESUME_PLAY_FALLBACK / 1000) + ' s (estado ' + avState() + '); dando play assim mesmo');
            startPlay(r);
            return;
        }
        if (r.nearMs >= 0 && now - r.nearAt > RESUME_FROZEN) {
            resumeFailed(r, 'chegou em ' + fmtTime(r.nearMs) + ' mas o video nao anda (estado ' + avState() + ')');
        } else if (now - r.at > RESUME_TIMEOUT) {
            resumeFailed(r, 'sem confirmacao em ' + (RESUME_TIMEOUT / 1000) + ' s (estado ' + avState() + ')');
        }
    }

    function startPlay(r, why) {
        if (r.played) { return; }
        r.played   = true;
        r.playedAt = Date.now();
        if (why) { console.log('[Player] play (' + why + ')'); }
        try { avplay.play(); } catch (e) { console.error('[AVPlay] play()', e && e.message); }
    }

    function issueResumeSeek(r) {
        var gen = loadGen;
        r.seekIssued = true;
        try {
            avplay.seekTo(r.ms, function () {
                if (gen !== loadGen || resumeAttempt !== r) { return; }
                if (r.m === 'ready') { startPlay(r, 'seek concluido'); }
            }, function (err) {
                if (gen !== loadGen || resumeAttempt !== r) { return; }
                resumeFailed(r, 'seek recusado em ' + fmtTime(r.ms) + ' (' + (err && err.message) + ')');
            });
        } catch (e) {
            if (resumeAttempt === r) { resumeFailed(r, 'seekTo falhou: ' + (e && e.message)); }
        }
    }

    /* comeca a tentativa atual do plano (player recem-preparado, estado READY) */
    function beginResume(step) {
        var plan = resumePlan;
        var tryMs = step.at;
        if (duration > 0) { tryMs = Math.min(tryMs, duration - 5000); }
        tryMs = Math.max(1000, tryMs);
        var r = {
            m: step.m, ms: tryMs, dir: plan.dir, target: plan.target, at: Date.now(),
            played: false, playedAt: 0, seekIssued: false,
            firstMs: -1,              // metodo 'playing': 1o playtime (p/ ver o video andar antes do seek)
            farFrom: -1,              // 1o playtime longe do alvo depois do seek (seek ignorado?)
            nearMs: -1, nearAt: 0     // 1o playtime perto do alvo (p/ ver se o video anda)
        };
        resumeAttempt = r;
        seekTarget   = tryMs;
        seekingUntil = Date.now() + RESUME_TIMEOUT + 5000;
        position     = tryMs;                     // so p/ a barra; lastPlayedMs e o real
        UI.showSpinner(true);
        armResumeWatchdog();
        console.log('[Player] ' + (r.dir > 0 ? 'pulando trecho' : 'retomada') + ': tentativa ' + (plan.step + 1) + '/' +
                    plan.length + ' em ' + fmtTime(tryMs) + ' (' + methodName(r.m) + ')');
        if (r.m === 'ready') { issueResumeSeek(r); }   // play() so quando o seek terminar
        else { startPlay(r); }                          // seek quando o video estiver andando
    }

    /* playtime durante a retomada */
    function noteResumePlaytime(r, ms) {
        if (r.m === 'playing' && !r.seekIssued) {
            if (r.firstMs < 0) { r.firstMs = ms; }
            else if (ms >= r.firstMs + 500) {
                console.log('[Player] video andando em ' + fmtTime(ms) + '; pedindo o seek');
                issueResumeSeek(r);
            }
            checkResumeTimeout();
            return;
        }
        if (!r.played) { checkResumeTimeout(); return; }   // antes do play() nao conta
        if (nearResume(r, ms)) {
            if (r.nearMs < 0 || ms < r.nearMs) { r.nearMs = ms; r.nearAt = Date.now(); }
            if (ms >= r.nearMs + 1000) { resumeOk(); return; }
        } else {
            if (r.farFrom < 0) { r.farFrom = ms; }
            else if (ms - r.farFrom > (r.m === 'ready' ? 3000 : RESUME_IGNORED_TOL)) {
                resumeFailed(r, 'seek ignorado (tocando em ' + fmtTime(ms) + ')');
                return;
            }
        }
        checkResumeTimeout();
    }

    function resumeOk() {
        var r = resumeAttempt;
        if (!r) { return; }
        console.log('[Player] ' + (r.dir > 0 ? 'trecho pulado' : 'retomada confirmada') + ' em ' +
                    fmtTime(lastPlayedMs || r.ms) + ' (' + methodName(r.m) + ')');
        // so memoriza o metodo quando ele foi a diferenca: retomada normal, no ponto
        // exato (sucesso pulando trecho / recuando nao diz nada sobre o metodo)
        if (r.dir < 0 && Math.abs(r.ms - r.target) < 1000 && PrefStore.get('resumeMethod') !== r.m) {
            PrefStore.set('resumeMethod', r.m);
            console.log('[Player] metodo de retomada preferido agora: ' + methodName(r.m));
        }
        clearResumeWatchdog();
        resumeAttempt = null;
        resumePlan    = null;
        seekingUntil  = 0;
        seekTarget    = 0;
        stallSince    = 0;
        stallStep     = 0;
        lastPlayMs    = position;
        UI.showSpinner(false);
    }

    /* a tentativa falhou: esse player fica num estado ruim (congelado, seek
     * recusado, erro), entao a proxima e SEMPRE num player reaberto */
    function resumeFailed(r, why) {
        if (resumeAttempt !== r) { return; }
        resumeAttempt = null;
        clearResumeWatchdog();
        seekingUntil = 0;
        seekTarget   = 0;
        var plan = resumePlan;
        console.warn('[Player] tentativa ' + (plan ? plan.step + 1 : '?') + ' (' + methodName(r.m) + ') falhou: ' + why);
        if (plan && plan.step + 1 < plan.length && reopenCount < 6) {
            plan.step++;
            reopenCount++;
            UI.toast(r.dir > 0 ? 'Pulando um trecho com problema do arquivo...' : 'Retomando de outro jeito...');
            loadAvplay(currentUri);
            return;
        }
        resumePlan = null;
        UI.showSpinner(false);
        if (r.dir > 0) {
            console.warn('[Player] nao consegui passar do trecho em', fmtTime(r.target));
            UI.toast('Nao consegui passar desse trecho do arquivo (' + fmtTime(r.target) + '). O ponto ficou salvo.');
            stopAndGoHome();
            return;
        }
        console.warn('[Player] retomada desistiu; tocando do inicio (ponto salvo ' + fmtTime(r.target) + ' preservado)');
        UI.toast('Nao consegui voltar ao ponto salvo (' + fmtTime(r.target) + '). Comecando do inicio - o ponto continua salvo.');
        resumeMs = 0;
        loadAvplay(currentUri);            // sem plano: abre e toca do inicio (isso sempre funcionou)
    }

    function loadAvplay(fileUri) {
        try { avplay.close(); } catch (e) {}
        clearResumeWatchdog();
        loadGen++;
        resumeAttempt = null;

        currentUri   = fileUri;
        started      = false;
        lastPlayedMs = 0;
        var step = (resumePlan && resumePlan.step < resumePlan.length) ? resumePlan[resumePlan.step] : null;
        if (step) { resumeGuard = Math.max(resumeGuard, resumePlan.target); }
        document.body.classList.add('playing');   // deixa a pagina transparente
        UI.showSpinner(true);

        avplay.open(fileUri);
        avplay.setDisplayRect(0, 0, 1920, 1080);
        try { avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}

        avplay.setListener({
            onbufferingstart:    function ()   { if (!started) { UI.showSpinner(true); } },
            onbufferingprogress: function (p)  {
                var pct = (position + (p / 100) * (duration - position)) / duration * 100;
                UI.setBuffered(pct);
                checkResumeTimeout();
            },
            onbufferingcomplete: function ()   {
                var r = resumeAttempt;
                if (!r) { UI.showSpinner(false); return; }
                // metodo 'ready': buffer pronto depois do seek = pode dar play
                // (caso o callback do seek demore ou nao venha)
                if (r.m === 'ready' && r.seekIssued && !r.played) { startPlay(r, 'buffer pronto apos o seek'); return; }
                checkResumeTimeout();
            },
            onstreamcompleted:   function ()   { clearWatchdog(); handleEnded(); },
            onerror: function (err) {
                clearWatchdog();
                console.error('[AVPlay] erro:', err, '(estado ' + avState() + ')');
                if (resumeAttempt) { resumeFailed(resumeAttempt, 'erro do player: ' + err); return; }
                UI.showSpinner(false);
                saveProgress();                       // nao perde o ponto atual
                seekingUntil = 0;
                seekTarget   = 0;
                if (reopenCount < 2 && started && lastPlayedMs >= 1000) {
                    reopenCount++;
                    UI.toast('Recuperando a reproducao...');
                    reopenAt(lastPlayedMs, -1, 'erro do player');   // onde estava TOCANDO
                } else {
                    UI.toast('Erro ao reproduzir: ' + (err && err.message || err));
                }
            },
            oncurrentplaytime: function (ms) {
                if (ms > 0) {
                    lastPlayedMs = ms;
                    if (!started) {                     // 1o frame renderizado
                        started = true;
                        clearWatchdog();
                        if (!resumeAttempt) { UI.showSpinner(false); }
                    }
                }
                var r = resumeAttempt;
                if (r && ms > 0) {
                    noteResumePlaytime(r, ms);
                } else if (r) {
                    checkResumeTimeout();
                } else if (seekingUntil && seekTarget && ms > 0 && Math.abs(ms - seekTarget) < 15000) {
                    seekingUntil = 0;              // seek do usuario concluiu, playtime voltou
                    seekTarget   = 0;
                    stallSince   = 0;
                    resumeGuard  = 0;              // o usuario levou o video pra outro ponto de verdade
                    UI.showSpinner(false);
                }
                if (resumeAttempt) {               // ainda retomando: barra mostra o alvo, nada de botoes
                    UI.updateProgress(position, duration);
                    return;
                }
                position = ms;
                UI.updateProgress(position, duration);
                UI.updateSkip(position, duration);
                UI.updateCredits(position, duration);
                autoSave();                        // nao depende so do tick
            }
        });

        // watchdog: se em 45s nao comecou, avisa (arquivo pesado / codec)
        clearWatchdog();
        watchdog = setTimeout(function () {
            if (!started) {
                UI.toast('Este arquivo esta demorando (bitrate alto ou codec pesado).');
            }
        }, 45000);

        avplay.prepareAsync(function () {
            duration = avplay.getDuration();
            if (!validMs(duration)) { duration = 0; }   // ver validMs() acima
            readTracks();
            UI.updateProgress(position, duration);
            startTick();                               // antes do beginResume (zera seekingUntil)
            if (step && duration > 0 && step.at < duration - 2000) {
                beginResume(step);                     // o play() fica a cargo do metodo
            } else {
                resumePlan = null;
                try { avplay.play(); } catch (e) { console.error('[AVPlay] play()', e); }
            }
        }, function (err) {
            clearWatchdog();
            UI.showSpinner(false);
            console.error('[AVPlay] prepareAsync falhou:', err);
            UI.toast('Nao foi possivel abrir o video.');
        });
    }

    function bindHtml5Events() {
        html5.addEventListener('loadedmetadata', function () {
            duration = Math.floor(html5.duration * 1000);
            if (resumeMs >= 1000 && resumeMs < duration - 2000) {
                html5.currentTime = resumeMs / 1000;
            }
            html5.play();
            startTick();
        });
        html5.addEventListener('timeupdate', function () {
            position = Math.floor(html5.currentTime * 1000);
            UI.updateProgress(position, duration);
            UI.updateSkip(position, duration);
            UI.updateCredits(position, duration);
        });
        html5.addEventListener('ended', handleEnded);
        html5.addEventListener('waiting', function () { UI.showSpinner(true); });
        html5.addEventListener('playing', function () { UI.showSpinner(false); });
        html5.addEventListener('progress', function () {
            try {
                if (html5.buffered.length && html5.duration) {
                    UI.setBuffered(html5.buffered.end(html5.buffered.length - 1) / html5.duration * 100);
                }
            } catch (e) {}
        });
    }

    /* --- controles --- */

    function togglePlay() {
        var r = resumeAttempt;
        if (App.usingAvplay && r && !r.played) {   // retomada esperando o seek: a tecla so antecipa o play
            startPlay(r, 'tecla play/pause');
            isPaused = false;
            return isPaused;
        }
        if (App.usingAvplay) {
            if (isPaused) { avplay.play(); } else { avplay.pause(); }
        } else {
            if (html5.paused) { html5.play(); } else { html5.pause(); }
        }
        isPaused = !isPaused;
        saveProgress();                       // grava sempre que pausa/despausa
        ProgressStore.flush();                // ...e ja manda pro HD
        return isPaused;
    }

    /* --- faixas de audio / legenda --- */
    function readTracks() {
        App.tracks = { audio: [], text: [] };
        App.trackSel = { audio: -1, text: -1 };
        if (!App.usingAvplay) { readHtml5Tracks(); UI.buildSettings(); return; }
        try {
            var info = avplay.getTotalTrackInfo() || [];
            for (var i = 0; i < info.length; i++) {
                var t = info[i], lang = '', label = '', forced = false;
                try {
                    var ex = JSON.parse(t.extra_info || '{}');
                    lang  = ex.language || ex.track_lang || ex.lang || '';
                    label = ex.name || ex.title || '';
                    forced = !!(ex.forced || ex.is_forced || ex.forced_subtitle);
                } catch (e) {}
                var rec = { index: t.index, lang: (lang || '').toLowerCase().trim(), label: label, forced: forced || isForcedLabel(label) };
                if (t.type === 'AUDIO') { App.tracks.audio.push(rec); }
                else if (t.type === 'TEXT') { App.tracks.text.push(rec); }
            }
            // faixa atual (AVPlay ja escolheu uma)
            try {
                var cur = avplay.getCurrentStreamInfo() || [];
                for (var j = 0; j < cur.length; j++) {
                    if (cur[j].type === 'AUDIO') { App.trackSel.audio = cur[j].index; }
                }
            } catch (e) {}
        } catch (e) { console.warn('[tracks] getTotalTrackInfo:', e && e.message); }
        console.log('[tracks] audio=' + App.tracks.audio.length + ' text=' + App.tracks.text.length);
        applyTrackPrefs();
        UI.buildSettings();
    }

    function readHtml5Tracks() {
        try {
            var at = html5.audioTracks || [];
            for (var i = 0; i < at.length; i++) {
                App.tracks.audio.push({ index: i, lang: (at[i].language || '').toLowerCase(), label: at[i].label || '' });
                if (at[i].enabled) { App.trackSel.audio = i; }
            }
            var tt = html5.textTracks || [];
            for (var k = 0; k < tt.length; k++) {
                var ttLabel = tt[k].label || '';
                App.tracks.text.push({ index: k, lang: (tt[k].language || '').toLowerCase(), label: ttLabel, forced: isForcedLabel(ttLabel) });
                if (tt[k].mode === 'showing') { App.trackSel.text = k; }
            }
        } catch (e) {}
    }

    function selectAudio(index) {
        App.trackSel.audio = index;
        if (App.usingAvplay) {
            try { avplay.setSelectTrack('AUDIO', index); } catch (e) { console.warn('[tracks] audio', e); }
        } else {
            try { for (var i = 0; i < html5.audioTracks.length; i++) { html5.audioTracks[i].enabled = (i === index); } } catch (e) {}
        }
        PrefStore.set('audioLang', trackLang('audio', index));
    }

    function selectText(index) {   // -1 = desligado ; <=-2 = legenda externa App.extSubs[-index-2]
        App.trackSel.text = index;
        var xs = index <= -2 ? (App.extSubs || [])[-index - 2] : null;
        if (App.usingAvplay) {
            try {
                if (index === -1) { avplay.setSilentSubtitle(true); }
                else if (xs && xs.uri) {
                    avplay.setExternalSubtitlePath(String(xs.uri).replace(/^file:\/\//, ''));
                    avplay.setSilentSubtitle(false);
                } else {
                    avplay.setSilentSubtitle(false);
                    avplay.setSelectTrack('TEXT', index);
                }
            } catch (e) { console.warn('[tracks] text', e); }
        } else {
            try {
                if (xs && xs.uri) {
                    addHtml5Track(xs);
                } else {
                    for (var i = 0; i < html5.textTracks.length; i++) {
                        html5.textTracks[i].mode = (i === index) ? 'showing' : 'disabled';
                    }
                }
            } catch (e) {}
        }
        PrefStore.set('subLang', index === -1 ? '_off'
                              : index <= -2  ? ('_file:' + ((xs && xs.lang) || ''))
                              : trackLang('text', index));
    }

    /* fallback HTML5: injeta um <track> apontando pro .srt externo */
    function addHtml5Track(xs) {
        try {
            var old = html5.querySelectorAll('track[data-ext]');
            for (var i = 0; i < old.length; i++) { html5.removeChild(old[i]); }
            var t = document.createElement('track');
            t.kind = 'subtitles'; t.src = xs.uri; t.srclang = xs.lang || 'pt';
            t.setAttribute('data-ext', '1'); t.default = true;
            html5.appendChild(t);
            setTimeout(function () { try { t.track.mode = 'showing'; } catch (e) {} }, 200);
        } catch (e) {}
    }

    function trackLang(kind, index) {
        var arr = App.tracks[kind];
        for (var i = 0; i < arr.length; i++) { if (arr[i].index === index) { return arr[i].lang || ''; } }
        return '';
    }

    /* legenda "forcada" nativa do arquivo: existe so p/ mostrar traducao nos trechos
     * em que se fala outro idioma (ex: cena em ingles dentro de episodio dublado em PT).
     * Deve ter prioridade sobre a preferencia de idioma salva (que e global, de outro
     * episodio/serie), senao uma preferencia antiga tipo "ingles" rouba esses trechos. */
    function isForcedLabel(label) { return /for[cç]/i.test(label || ''); }

    /* aplica a preferencia salva (idioma) ao trocar de episodio */
    function applyTrackPrefs() {
        var aPref = PrefStore.get('audioLang'), sPref = PrefStore.get('subLang');
        if (aPref) {
            var a = App.tracks.audio.filter(function (t) { return langMatch(t.lang, aPref); })[0];
            if (a && a.index !== App.trackSel.audio) { selectAudio(a.index); }
        }
        var xs = App.extSubs || [];
        var forced = App.tracks.text.filter(function (t) { return t.forced; })[0];
        if (sPref === '_off') { selectText(-1); }
        else if (sPref && sPref.indexOf('_file') === 0 && xs.length) {
            var want = sPref.split(':')[1] || '';
            var pos = 0;
            for (var j = 0; j < xs.length; j++) { if (want && langMatch(xs[j].lang, want)) { pos = j; break; } }
            selectText(-2 - pos);
        }
        else if (sPref) {
            var s = App.tracks.text.filter(function (t) { return langMatch(t.lang, sPref); })[0];
            // preferencia salva e de outro idioma que a legenda forcada nativa: a forcada ganha,
            // pois ela existe justamente p/ aparecer nesses trechos independente do idioma escolhido
            if (forced && (!s || !langMatch(s.lang, forced.lang))) { selectText(forced.index); }
            else if (s) { selectText(s.index); }
            else if (xs.length) { selectText(-2); }
            else { selectText(-1); }
        } else if (forced) { selectText(forced.index); }
        else if (App.tracks.text.length === 0 && xs.length) {
            selectText(-2);
        }
    }
    function langMatch(a, b) {
        a = (a || '').slice(0, 2); b = (b || '').slice(0, 2);
        return a && b && a === b;
    }

    function seekBy(deltaMs) { seekTo(position + deltaMs); }

    /* Marca que um seek esta em curso: o detector de travamento fica em silencio
     * ate o playtime voltar perto do alvo (ou expirar a janela). Seeks longos em
     * arquivo do USB podem rebufferizar 10-15s - isso NAO e travamento. */
    function markSeek(targetMs) {
        seekTarget   = targetMs;
        seekingUntil = Date.now() + 20000;
        stallSince   = 0;
        stallStep    = 0;
        UI.showSpinner(true);
    }

    function seekTo(ms) {
        var target = Math.max(0, Math.min(ms, duration - 1000));
        if (resumeAttempt) {                   // o usuario assumiu durante a retomada
            var r = resumeAttempt;
            clearResumeWatchdog();
            resumeAttempt = null;
            resumePlan    = null;
            if (App.usingAvplay && !r.played) { try { avplay.play(); } catch (e) {} }
        }
        if (App.usingAvplay) {
            // o ponto salvo (resumeGuard) so e liberado quando o seek CONFIRMA
            // (oncurrentplaytime): seek recusado nao pode gravar o alvo
            var gen = loadGen, before = lastPlayedMs;
            markSeek(target);
            try {
                // com callbacks: sem o de erro, a falha estoura dentro do
                // webapis.js ("Script error") em vez de cair aqui
                avplay.seekTo(target, function () {}, function (err) {
                    if (gen !== loadGen) { return; }
                    console.warn('[Player] seek recusado em', fmtTime(target), err && err.message, '(estado ' + avState() + ')');
                    seekingUntil = 0;
                    seekTarget   = 0;
                    if (before) { position = before; }
                    UI.showSpinner(false);
                    UI.toast('Nao consegui ir para esse ponto do video.');
                });
            } catch (e) { console.error('[AVPlay] seekTo', e && e.message); }
        } else {
            resumeGuard = 0;
            html5.currentTime = target / 1000;
        }
        position = target;
    }

    function stop(saveFirst) {
        if (saveFirst !== false) { saveProgress(); }
        ProgressStore.flush();
        stopTick();
        clearWatchdog();
        clearResumeWatchdog();
        if (resumeAttempt) { console.log('[Player] parado durante a retomada (ponto salvo preservado)'); }
        resumeAttempt = null;
        loadGen++;                             // ignora callbacks atrasados desta abertura
        UI.showSpinner(false);
        UI.hideSkip();
        UI.closeSettings();
        document.body.classList.remove('playing');
        if (App.usingAvplay) {
            try { avplay.stop(); avplay.close(); } catch (e) {}
        } else {
            html5.pause();
            html5.removeAttribute('src');
            html5.load();
        }
    }

    function handleEnded() {
        stopTick();
        ProgressStore.markComplete(App.playingPath);
        if (onEndedCb) { onEndedCb(); }
    }

    /* --- gravacao periodica de progresso (pilar 3) --- */

    function startTick() {
        stopTick();
        lastPlayMs   = position;
        stallSince   = 0;
        stallStep    = 0;
        if (!resumeAttempt) { seekingUntil = 0; }   // retomada em curso mantem a protecao dela
        saveProgress();                        // grava logo o ponto inicial (nao grava durante a retomada)
        tickTimer = setInterval(function () {
            checkResumeTimeout();
            if (isPaused) { return; }
            autoSave();
            checkStall();
        }, 3000);                              // grava / verifica a cada 3s
    }

    /* gravacao periodica (~3 s): chamada pelo tick E por cada playtime do
     * AVPlay - os timers do JS podem parar de disparar com o player ativo
     * nessa TV, e ai o progresso so seria salvo ao pausar/sair */
    var lastAutoSave = 0;
    function autoSave() {
        if (isPaused) { return; }
        var now = Date.now();
        if (now - lastAutoSave < 3000) { return; }
        lastAutoSave = now;
        saveProgress();
    }
    function stopTick() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    /* Detecta "congelou do nada": position parada por varios segundos com o
     * video tocando (e SEM seek em andamento). Escada de recuperacao:
     *   12 s -> reemite play();
     *   22 s -> REABRE o arquivo nesse ponto usando a mesma maquina da retomada
     *           para FRENTE (dir +1): os dois metodos no ponto e, se nao der,
     *           30 s adiante - nunca seek dentro do player parado (falha com
     *           PLAYER_ERROR_SEEK_FAILED nessa TV) e nunca recomeca do zero;
     *   38 s -> desiste e volta pra tela inicial.
     * Nao usa pause()+play(): interrompe seek em curso e trava o AVPlay. */
    function checkStall() {
        if (!App.usingAvplay || !started) { return; }
        if (resumeAttempt) { return; }               // a retomada tem o proprio controle de tempo
        if (Date.now() < seekingUntil) { return; }   // seek/rebuffer normal, nao e travamento

        if (position !== lastPlayMs) {         // avancou normalmente
            lastPlayMs = position;
            stallSince = 0;
            stallStep  = 0;
            return;
        }
        if (!stallSince) { stallSince = Date.now(); return; }

        var stuck = Date.now() - stallSince;
        if (stuck < 12000) { return; }         // ainda pode ser buffering normal

        saveProgress();                        // garante o ponto atual salvo

        if (stallStep === 0) {
            stallStep = 1;
            console.warn('[Player] video parado em ' + fmtTime(position) + ' (estado ' + avState() + ')');
            UI.toast('Recuperando a reproducao...');
            try { avplay.play(); } catch (e) {}  // reemite play (seek aqui falha com o player parado)
        } else if (stallStep === 1 && stuck >= 22000) {
            stallStep = 2;
            if (duration > 0 && position >= duration - 20000) {     // travou nos creditos: encerra
                console.warn('[Player] travou perto do fim (' + fmtTime(position) + '); encerrando o episodio');
                handleEnded();
                return;
            }
            if (currentUri && reopenCount < 4) {
                reopenCount++;
                UI.toast('Recuperando a reproducao...');
                reopenAt(position, 1, 'travou em ' + fmtTime(position) + ' (estado ' + avState() + ')');
            } else {
                stallStep = 2.5;              // sem mais reaberturas -> proximo passo desiste
            }
        } else if (stallStep >= 2 && stuck >= 38000) {
            stallStep = 3;
            stopTick();
            UI.toast('Nao consegui continuar este episodio. Ele ficou salvo em "Continuar assistindo".');
            stopAndGoHome();
        }
    }

    function saveProgress() {
        if (!App.playingPath || duration <= 0) { return; }
        if (resumeAttempt) { return; }         // retomada em andamento: posicao ainda nao e real
        // player (re)aberto que ainda nao tocou nada: posicao nao e real (o
        // ponto salvo regredia gravando o alvo de uma tentativa no meio da troca)
        if (App.usingAvplay && !started) { return; }
        if (seekTarget && Date.now() < seekingUntil) { return; }   // seek pendente: posicao otimista
        // retomada falhou / caiu no comeco: nao sobrescreve o ponto salvo
        if (resumeGuard && position < resumeGuard - 30000) { return; }
        ProgressStore.save({
            path:     App.playingPath,
            name:     baseName(App.playingPath),
            dir:      dirName(App.playingPath),
            position: position,
            duration: duration,
            done:     position >= duration * COMPLETE_RATIO,
            updated:  Date.now()
        });
    }

    return {
        init: init, load: load, togglePlay: togglePlay, seekBy: seekBy, seekTo: seekTo,
        stop: stop, saveProgress: saveProgress,
        poke: checkResumeTimeout,              // tecla do controle: reconfere o prazo da retomada
        selectAudio: selectAudio, selectText: selectText,
        getPosition: function () { return position; },
        getDuration: function () { return duration; },
        isPaused:    function () { return isPaused; }
    };
})();


/* ============================================================================
 * 3. PROGRESS STORE  (HD + localStorage)
 *    Chave por arquivo = caminho relativo a biblioteca. Guarda posicao,
 *    duracao, "done" e "updated".
 * ==========================================================================*/

/* ProgressStore - "Continuar assistindo".
 *
 * O localStorage sozinho NAO e confiavel aqui: ele fica dentro do sandbox do
 * app e ja se perdeu/voltou no tempo depois de reinstalacoes (aconteceu
 * durante os testes do NetUpload em Set/2026). Por isso o progresso tambem
 * vai para um arquivo de verdade no HD (AmorecoFlix/progresso.json, mesmo
 * padrao do skip.json), que sobrevive a qualquer reinstalacao do app porque
 * fica fora do sandbox dele. Ao abrir, os dois sao mesclados por episodio. */
var ProgressStore = (function () {

    var KEY = 'meuplayer.progress.v1';
    var FILE_NAME = 'progresso.json';
    var BAK_NAME  = 'progresso.bak.json';   // copia do anterior: se faltar energia no meio da gravacao
    var DISK_EVERY = 30000;                 // localStorage a cada save; HD no maximo a cada 30 s
    var libDir = null;
    var cache = normalize(load());
    var writing = false, pendingWrite = false;
    var dirty = false, lastDisk = 0;

    /* Chave = caminho RELATIVO a pasta da biblioteca ("Series/Show/.../ep.mkv").
     * Antes era o caminho completo na TV ("/opt/media/USBDriveA1/AmorecoFlix/..."):
     * se a TV montasse o HD com outro nome (outra porta, HD religado depois de
     * ir ao PC), todo o progresso "sumia". Caminho fora da biblioteca fica completo. */
    function keyOf(p) {
        p = String(p || '');
        var base = libDir && libDir.fullPath;
        if (base && p.indexOf(base + '/') === 0) { return p.slice(base.length + 1); }
        var marker = '/' + LIBRARY_DIR.toLowerCase() + '/';
        var i = p.toLowerCase().indexOf(marker);
        return i !== -1 ? p.slice(i + marker.length) : p;
    }
    /* caminho completo atual (no HD montado agora) de uma chave */
    function fullOf(k) {
        if (k.charAt(0) === '/' || !libDir || !libDir.fullPath) { return k; }
        return libDir.fullPath + '/' + k;
    }

    /* converte um mapa antigo (chaves completas) p/ chaves relativas; se duas
       chaves viram a mesma (montagens diferentes do HD), fica a mais recente */
    function normalize(obj) {
        var out = {};
        for (var k in obj) {
            if (!obj.hasOwnProperty(k)) { continue; }
            var r = obj[k];
            if (!r || typeof r !== 'object') { continue; }
            var nk = keyOf(k);
            if (out[nk] && (out[nk].updated || 0) >= (r.updated || 0)) { continue; }
            r.path = nk;
            r.dir  = dirName(nk);
            out[nk] = r;
        }
        return out;
    }

    function load() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch (e) { return {}; }
    }
    function persistLocal() {
        try { localStorage.setItem(KEY, JSON.stringify(cache)); }
        catch (e) { console.error('[Store] localStorage cheio?', e); }
    }

    /* chamado pelo scanUsb() assim que a pasta AmorecoFlix e encontrada.
       Junta o arquivo do HD com o cache local registro a registro, ficando
       com o mais recente de cada episodio (campo "updated"): o HD sobrevive
       a reinstalacoes do app, e o local tem o que ainda nao foi pro HD
       (gravado no maximo a cada 30 s). progresso.json corrompido -> .bak. */
    function loadFromDisk(libraryDir) {
        libDir = libraryDir;
        if (!libDir || !libDir.fullPath) { return; }
        cache = normalize(cache);                  // agora da pra tirar o prefixo real do HD
        var base = libDir.fullPath + '/';

        function use(obj, from) {
            var disk = normalize(obj), out = {}, k, newerLocal = 0;
            for (k in disk) { if (disk.hasOwnProperty(k)) { out[k] = disk[k]; } }
            for (k in cache) {
                if (!cache.hasOwnProperty(k)) { continue; }
                if (!out[k] || (cache[k].updated || 0) > (out[k].updated || 0)) { out[k] = cache[k]; newerLocal++; }
            }
            cache = out;
            persistLocal();
            console.log('[Store] progresso do HD (' + from + '): ' + Object.keys(cache).length +
                        ' itens, ' + newerLocal + ' mais novos no cache local');
            if (newerLocal) { dirty = true; flush(); }
            else if (window.DebugLog) { DebugLog.persist(); }   // log do boot vai pro HD
            if (window.UI && UI.renderContinue) { UI.renderContinue(); }
        }
        function parse(txt) {
            try { var o = JSON.parse(txt); return (o && typeof o === 'object') ? o : null; }
            catch (e) { return null; }
        }
        function tryBackup(mainExists) {
            readTextFile(base + BAK_NAME, function (txt) {
                var o = parse(txt);
                if (o) { use(o, BAK_NAME); dirty = true; flush(); return; }   // reconstroi o principal
                console.warn('[Store] progresso.json e .bak invalidos - mantendo o cache local');
                if (Object.keys(cache).length) { dirty = true; flush(); }
            }, function () {
                if (mainExists) { console.warn('[Store] progresso.json invalido e sem .bak'); }
                /* ainda nao existe no HD - se ja tem progresso local, migra pra ele agora */
                if (Object.keys(cache).length) { dirty = true; flush(); }
            });
        }
        readTextFile(base + FILE_NAME, function (txt) {
            var o = parse(txt);
            if (o) { use(o, FILE_NAME); } else { tryBackup(true); }
        }, function () { tryBackup(false); });
    }

    /* grava o conteudo inteiro num arquivo da biblioteca (cria se nao existir) */
    function writeFile(name, json, done) {
        var path = libDir.fullPath + '/' + name;
        function doWrite(fileObj) {
            try {
                fileObj.openStream('w', function (s) {
                    try { s.write(json); } catch (e) { console.warn('[Store] erro escrevendo ' + name + ':', e && e.message); }
                    try { s.close(); } catch (e) {}
                    done();
                }, function (e) {
                    console.warn('[Store] erro abrindo ' + name + ' p/ escrita:', e && e.message);
                    done();
                }, 'UTF-8');
            } catch (e) { console.warn('[Store] erro escrevendo ' + name + ':', e && e.message); done(); }
        }
        try {
            tizen.filesystem.resolve(path, doWrite, function () {
                try {
                    tizen.filesystem.resolve(libDir.fullPath, function (dir) {
                        doWrite(dir.createFile(name));
                    }, function (e) { console.warn('[Store] erro criando ' + name + ':', e && e.message); done(); }, 'rw');
                } catch (e) { done(); }
            }, 'rw');
        } catch (e) { console.warn('[Store] erro geral escrevendo ' + name + ':', e && e.message); done(); }
    }

    /* principal primeiro, depois o .bak: uma queda de energia so corrompe
       um dos dois, e o outro tem no maximo a gravacao anterior */
    function writeToDisk() {
        if (!libDir || !libDir.fullPath || !window.tizen) { return; }
        if (writing) { pendingWrite = true; return; }
        writing = true;
        var json = JSON.stringify(cache);
        writeFile(FILE_NAME, json, function () {
            writeFile(BAK_NAME, json, function () {
                writing = false;
                if (pendingWrite) { pendingWrite = false; writeToDisk(); }
            });
        });
    }

    /* grava no HD agora, se houver algo pendente (pausa, parada, saida do app) */
    function flush() {
        if (window.DebugLog) { DebugLog.persist(); }
        if (!dirty) { return; }
        dirty = false;
        lastDisk = Date.now();
        writeToDisk();
    }

    /* localStorage sempre; HD no maximo a cada DISK_EVERY (o Player salva a
       cada 3 s - regravar o arquivo inteiro no HD USB nesse ritmo e desperdicio) */
    function persist(urgent) {
        persistLocal();
        dirty = true;
        if (urgent || Date.now() - lastDisk >= DISK_EVERY) { flush(); }
    }

    /** Salva/atualiza o registro de um arquivo (rec.path = caminho completo). */
    function save(rec) {
        var k = keyOf(rec.path);
        rec.path = k;
        rec.dir  = dirName(k);
        cache[k] = rec;
        persist(false);
    }

    /** Retorna o registro de um arquivo pelo caminho completo (ou null). */
    function get(path) {
        return cache[keyOf(path)] || null;
    }

    /** Marca como concluido e zera a posicao (para nao aparecer em "continuar"). */
    function markComplete(path) {
        var r = cache[keyOf(path)];
        if (r) {
            r.done = true;
            r.position = 0;
            r.updated = Date.now();
            persist(true);
        }
    }

    /** Itens NAO concluidos, mais recentes primeiro (aba Continuar Assistindo).
        Devolve copias com path = caminho completo no HD montado agora. */
    function continueList(limit) {
        var arr = [];
        for (var p in cache) {
            if (!cache.hasOwnProperty(p)) { continue; }
            var r = cache[p];
            if (r && !r.done && r.position >= 1000) {
                var c = {};
                for (var f in r) { if (r.hasOwnProperty(f)) { c[f] = r[f]; } }
                c.path = fullOf(p);
                arr.push(c);
            }
        }
        arr.sort(function (a, b) { return b.updated - a.updated; });
        return limit ? arr.slice(0, limit) : arr;
    }

    function remove(path) { delete cache[keyOf(path)]; persist(true); }
    function clearAll()   { cache = {}; persist(true); }

    return {
        save: save, get: get, markComplete: markComplete,
        continueList: continueList, remove: remove, clearAll: clearAll,
        loadFromDisk: loadFromDisk, flush: flush
    };
})();


/* Preferencias simples (idioma de audio/legenda escolhido pelo usuario) */
var PrefStore = (function () {
    var KEY = 'amorecoflix.prefs.v1', c = {};
    try { c = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    function set(k, v) { c[k] = v; try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }
    function get(k) { return c[k]; }
    return { set: set, get: get };
})();


/* Nome legivel de um codigo de idioma */
var LANG_NAMES = {
    por: 'Portugues', pt: 'Portugues', pob: 'Portugues (BR)', 'pt-br': 'Portugues (BR)',
    eng: 'Ingles', en: 'Ingles',
    spa: 'Espanhol', es: 'Espanhol', jpn: 'Japones', ja: 'Japones',
    fre: 'Frances', fra: 'Frances', fr: 'Frances', ger: 'Alemao', deu: 'Alemao', de: 'Alemao',
    ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano',
    chi: 'Chines', zho: 'Chines', zh: 'Chines', rus: 'Russo', ru: 'Russo',
    mul: 'Multiplo', und: '', '': ''
};
function langName(code, fallback) {
    code = (code || '').toLowerCase().trim();
    var n = LANG_NAMES[code];
    if (n) { return n; }
    if (n === '') { return fallback || 'Original'; }
    return code ? (code.charAt(0).toUpperCase() + code.slice(1)) : (fallback || 'Faixa');
}


/* ============================================================================
 * 4. PROXIMO EPISODIO
 *    Assume nomenclatura tipo S01E01 / S01E02 e ordem alfabetica natural.
 * ==========================================================================*/

/* Proximo arquivo da playlist (pasta do episodio atual). No ultimo episodio
 * da pasta, cai no 1o da proxima temporada, se findNextSeason() ja achou. */
function findNextEpisode(currentPath) {
    var idx = App.playlist.findIndex(function (e) {
        return e.file.fullPath === currentPath;
    });
    if (idx !== -1 && idx + 1 < App.playlist.length) { return App.playlist[idx + 1]; }
    return (App.nextSeason && App.playingPath === currentPath) ? App.nextSeason.entry : null;
}

/* numero da temporada pelo nome da pasta: "Show - 2ª Temporada", "Temporada 2",
 * "Season 2", "S02". 0 = nao e pasta de temporada. */
function seasonNumber(name) {
    var m = /(\d{1,2})\s*[ªºa°]?\s*temporada/i.exec(name) ||
            /temporada\s*(\d{1,2})/i.exec(name) ||
            /season\s*(\d{1,2})/i.exec(name) ||
            /\bS(\d{1,2})\b/i.exec(name);
    return m ? parseInt(m[1], 10) : 0;
}

/* Cada temporada fica na propria pasta, entao o ultimo episodio de uma nao
 * tem "proximo" na playlist. Procura a pasta irma da temporada seguinte e
 * devolve (async) o 1o episodio dela + a lista completa. */
function findNextSeason(currentPath, cb) {
    var seasonDir = dirName(currentPath), showDir = dirName(seasonDir);
    var cur = seasonNumber(baseName(seasonDir));
    if (!cur || !showDir || !(window.tizen && tizen.filesystem)) { return; }
    try {
        tizen.filesystem.resolve(showDir, function (dir) {
            listDirectory(dir, function (entries) {
                var target = entries.filter(function (e) {
                    return e.isDir && seasonNumber(e.name) === cur + 1;
                })[0];
                if (!target) { return; }
                listDirectory(target.file, function (eps) {
                    var list = eps.filter(function (e) { return !e.isDir; });
                    if (list.length) { cb(list[0], list); }
                });
            });
        }, function (e) { console.warn('[Next] pasta da serie:', e && e.message); }, 'r');
    } catch (e) { console.warn('[Next] proxima temporada:', e && e.message); }
}


/* ============================================================================
 * 4b. INDICE DE CONTEUDO  (tizen.content -> miniaturas + duracao)
 *     O scanner de midia da TV gera thumbnails automaticamente para os
 *     videos do USB. Consultamos isso e cruzamos pelo caminho do arquivo.
 * ==========================================================================*/

var ContentIndex = (function () {

    var map = {};      // caminho (sem file://) -> { thumb, duration(ms), title, w, h }

    function key(p) {
        return String(p || '')
            .replace(/^file:\/\//, '')
            .replace(/\\/g, '/');
    }

    function absorb(items) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it || !it.contentURI) { continue; }
            var thumb = (it.thumbnailURIs && it.thumbnailURIs.length)
                        ? it.thumbnailURIs[0] : null;
            map[key(it.contentURI)] = {
                thumb:    thumb,
                duration: Number(it.duration) || 0,
                title:    it.title || null,
                w: it.width || 0, h: it.height || 0
            };
        }
    }

    var loaded = false, loading = false, waiters = [];

    /** Consulta 1x todos os videos indexados pela TV (so pra pegar titulos). */
    function query(done) {
        if (loaded) { done && done(); return; }
        waiters.push(done || function () {});
        if (loading) { return; }
        loading = true;

        if (!(window.tizen && tizen.content && tizen.content.find)) {
            console.warn('[content] tizen.content.find INDISPONIVEL');
            return flush();
        }
        var filter = null;
        try { filter = new tizen.AttributeFilter('type', 'EXACTLY', 'VIDEO'); }
        catch (e) { console.warn('[content] AttributeFilter falhou:', e && e.message); }

        tizen.content.find(function (items) {
            console.log('[content] find 1x OK:', items.length,
                        'videos | thumb=', items[0] && JSON.stringify(items[0].thumbnailURIs));
            absorb(items);
            flush();
        }, function (e) {
            console.warn('[content] find falhou:', e && (e.name + ' ' + e.message));
            flush();
        }, null, filter);
    }
    function flush() {
        loaded = true; loading = false;
        var w = waiters; waiters = [];
        w.forEach(function (fn) { try { fn(); } catch (e) {} });
    }

    function get(fullPath) { return map[key(fullPath)] || null; }

    return { query: query, get: get };
})();


/* ============================================================================
 * 4c. MINIATURAS  (a TV nao fornece -> geramos e cacheamos)
 *     Ordem: cache local  ->  imagem "capa" na pasta  ->  frame do video.
 * ==========================================================================*/

var Thumbs = (function () {

    var KEY   = 'amorecoflix.thumbs.v2';
    var cache = load();
    var queue = [];
    var busy  = false;

    function load() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch (e) { return {}; }
    }
    function persist() {
        try { localStorage.setItem(KEY, JSON.stringify(cache)); }
        catch (e) {
            var arr = Object.keys(cache)
                .map(function (k) { return [k, cache[k].t || 0]; })
                .sort(function (a, b) { return a[1] - b[1]; });
            var n = Math.max(1, Math.ceil(arr.length * 0.25));
            for (var i = 0; i < n; i++) { delete cache[arr[i][0]]; }
            try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e2) {}
        }
    }
    function get(path) { return cache[path] || null; }             // { u, d, t }
    function put(path, url, durMs) {
        cache[path] = { u: url, d: durMs || 0, t: Date.now() };
        persist();
    }

    /* nomes genericos de capa aceitos numa pasta */
    var GENERIC = ['poster', 'folder', 'capa', 'cover', 'fanart', 'thumb', 'thumbnail', 'backdrop'];

    function norm(s) {
        return String(s).toLowerCase()
            .replace(/\[[^\]]*\]/g, ' ')          // tira [1080p], [Legendado]...
            .replace(/\([^)]*\)/g, ' ')           // tira (2024)
            .replace(/[._\-]+/g, ' ')
            .replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|h265|hevc|web dl|webrip|bluray|dual|legendado|dublado)\b/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    /* acha imagem de capa: mesmo nome do video, nome da pasta, ou generico */
    function sidecarFor(entry, images, dirName_) {
        if (!images || !images.length) { return null; }
        var vb = norm(stripExt(entry.name));
        var db = dirName_ ? norm(dirName_) : '';
        var i;
        for (i = 0; i < images.length; i++) {          // 1) mesmo nome do arquivo
            if (norm(images[i].base) === vb && vb) { return images[i].file; }
        }
        for (i = 0; i < images.length; i++) {          // 2) generico (poster.jpg...)
            if (GENERIC.indexOf(images[i].base) !== -1) { return images[i].file; }
        }
        for (i = 0; i < images.length; i++) {          // 3) nome da pasta
            if (db && norm(images[i].base) === db) { return images[i].file; }
        }
        if (images.length === 1) { return images[0].file; }   // 4) unica imagem da pasta
        return null;
    }

    /* resolucao imediata: cache ou imagem de capa. Retorna URL ou null. */
    function quick(entry, images, dirName_) {
        var c = cache[entry.file.fullPath];
        if (c && c.u) { return c.u; }
        var sc = sidecarFor(entry, images, dirName_);
        if (sc) {
            var uri;
            try { uri = sc.toURI(); } catch (e) { return null; }
            put(entry.file.fullPath, uri, (c && c.d) || 0);
            return uri;
        }
        return null;
    }

    /* le SO a duracao do arquivo (metadata) - o frame do video da preto nessa TV */
    function probeDuration(entry, cb) {
        var path = entry.file.fullPath;
        if (cache[path] && cache[path].d) { cb && cb(cache[path]); return; }
        queue.push({ entry: entry, path: path, cb: cb });
        pump();
    }

    function pump() {
        if (busy || !queue.length) { return; }
        if (document.body.classList.contains('playing')) { setTimeout(pump, 3000); return; }
        busy = true;
        var job = queue.shift();
        var uri;
        try { uri = job.entry.file.toURI(); } catch (e) { uri = null; }
        if (!uri) { return done(job, 0); }

        var v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true;
        v.style.cssText = 'position:fixed;left:-99px;top:-99px;width:2px;height:2px';
        document.body.appendChild(v);
        var settled = false;
        var to = setTimeout(function () { fin(0); }, 12000);
        function fin(ms) {
            if (settled) { return; } settled = true;
            clearTimeout(to);
            try { v.removeAttribute('src'); v.load(); } catch (e) {}
            if (v.parentNode) { v.parentNode.removeChild(v); }
            done(job, ms);
        }
        v.onloadedmetadata = function () {
            fin((isFinite(v.duration) && v.duration > 0) ? Math.round(v.duration * 1000) : 0);
        };
        v.onerror = function () { fin(0); };
        v.src = uri;
    }

    function done(job, durMs) {
        var cur = cache[job.path] || {};
        cache[job.path] = { u: cur.u || null, d: durMs || cur.d || 0, t: Date.now() };
        if (durMs) { persist(); }
        busy = false;
        job.cb && job.cb(cache[job.path]);
        setTimeout(pump, 40);
    }

    return { get: get, quick: quick, probeDuration: probeDuration };
})();


/* ============================================================================
 * 4d. PASTA CENTRAL DE CAPAS  (<biblioteca>/thumbs/<nome do video>.jpg)
 *     Gerada no PC por gerar-thumbnails.ps1. Uma consulta so, no boot.
 * ==========================================================================*/

var ThumbsFolder = (function () {

    var map = null;            // "nome do video.mkv" (lower) -> uri ; null = nao carregado
    var loading = false;

    /* force = reescaneou (tecla VERMELHA / HD trocado): reindexa capas novas.
       O mapa antigo continua valendo ate o novo ficar pronto. */
    function load(libDir, force) {
        if (loading || !libDir || !libDir.listFiles) { return; }
        if (map !== null && !force) { return; }
        loading = true;
        libDir.listFiles(function (files) {
            for (var i = 0; i < files.length; i++) {
                if (files[i].isDirectory && files[i].name.toLowerCase() === 'thumbs') {
                    return indexFolder(files[i]);
                }
            }
            console.warn('[thumbs] pasta "thumbs" ausente na biblioteca');
            map = {}; loading = false;
        }, function (e) {
            console.warn('[thumbs] erro ao abrir a biblioteca:', e && e.message);
            map = {}; loading = false;
        });
    }

    function indexFolder(dir) {
        dir.listFiles(function (files) {
            map = {};
            for (var i = 0; i < files.length; i++) {
                if (files[i].isDirectory) { continue; }
                // "Death Parade Ep 01.mkv.jpg" -> chave "death parade ep 01.mkv"
                var key = files[i].name.replace(/\.jpe?g$/i, '').toLowerCase();
                try { map[key] = files[i].toURI(); } catch (e) {}
            }
            console.log('[thumbs] indexado:', Object.keys(map).length, 'capas em /thumbs');
            loading = false;
            if (window.UI && UI.refreshThumbs) { UI.refreshThumbs(); }
        }, function (e) {
            console.warn('[thumbs] erro ao ler /thumbs:', e && e.message);
            map = {}; loading = false;
        });
    }

    /* videoName = nome COMPLETO do arquivo de video (com extensao) */
    function get(videoName) {
        if (!map) { return null; }
        return map[String(videoName).toLowerCase()] || null;
    }
    function ready() { return map !== null; }

    return { load: load, get: get, ready: ready };
})();


/* ============================================================================
 * 4e. PULAR ABERTURA  (intervalos de OP/ED por episodio, do skip.json)
 *     Gerado no PC por skip-anime.ps1 (dados da API AniSkip).
 * ==========================================================================*/

var SkipData = (function () {
    var map = null;   // "nome do arquivo" (lower) -> { op:[iniSeg,fimSeg], ed:[...] }

    /* force = reescaneou: rele o skip.json (creditos/aberturas recem-detectados) */
    function load(libDir, force) {
        if (!libDir || !libDir.fullPath) { return; }
        if (map !== null && !force) { return; }
        if (map === null) { map = {}; }              // o mapa antigo vale ate o novo chegar
        readTextFile(libDir.fullPath + '/skip.json', function (txt) {
            try {
                var raw = JSON.parse(txt), m = {};
                for (var k in raw) { if (raw.hasOwnProperty(k)) { m[k.toLowerCase()] = raw[k]; } }
                map = m;
                console.log('[skip] skip.json:', Object.keys(map).length, 'episodios');
            } catch (e) { console.warn('[skip] json invalido:', e && e.message); }
        }, function () { console.log('[skip] skip.json ausente'); map = {}; });
    }

    function get(videoName) {
        if (!map) { return null; }
        return map[String(videoName).toLowerCase()] || null;
    }
    return { load: load, get: get };
})();


/* ============================================================================
 * 4f. LEGENDAS EXTERNAS  (pasta central <biblioteca>/subs, igual /thumbs)
 *     Arquivo casado pelo NOME COMPLETO do video:
 *       subs/<video.mkv>.srt          -> legenda unica
 *       subs/<video.mkv>.pt.srt       -> idioma no penultimo ponto
 *       subs/<video.mkv>.pt.forced.srt-> forcada
 *     Movidas para ca no PC por organizar-subs.ps1.
 * ==========================================================================*/

var SubsFolder = (function () {

    var map = null;           // "video.mkv" (lower) -> [ {name,uri,lang,forced} ] ; null = nao carregado
    var loading = false;
    var SUB_RE  = /\.(srt|ass|ssa|vtt|sub)$/i;
    var TOKEN_RE = /\.([a-z-]{2,10})$/i;

    /* force = reescaneou: reindexa legendas novas (o mapa antigo vale ate o novo ficar pronto) */
    function load(libDir, force) {
        if (loading || !libDir || !libDir.listFiles) { return; }
        if (map !== null && !force) { return; }
        loading = true;
        libDir.listFiles(function (files) {
            for (var i = 0; i < files.length; i++) {
                if (files[i].isDirectory && files[i].name.toLowerCase() === 'subs') {
                    return indexFolder(files[i]);
                }
            }
            console.log('[subs] pasta "subs" ausente na biblioteca');
            map = {}; loading = false;
        }, function (e) {
            console.warn('[subs] erro ao abrir a biblioteca:', e && e.message);
            map = {}; loading = false;
        });
    }

    /* "The Vampire Diaries S04E01.mp4.pt.forced.srt"
     *   -> { key:"the vampire diaries s04e01.mp4", lang:"pt", forced:true } */
    function parse(fileName) {
        var n = fileName.replace(SUB_RE, ''), lang = '', forced = false, m, tok, guard = 0;
        while (guard++ < 3 && (m = n.match(TOKEN_RE))) {
            tok = m[1].toLowerCase();
            if (tok === 'forced') { forced = true; }
            else if (/^(pt|pt-br|ptbr|por|portugues)$/.test(tok)) { lang = lang || 'pt'; }
            else if (/^(en|eng|ing|ingles)$/.test(tok))           { lang = lang || 'en'; }
            else if (/^(es|spa|esp|espanhol)$/.test(tok))         { lang = lang || 'es'; }
            else if (/^(ja|jpn|jap|jp)$/.test(tok))               { lang = lang || 'ja'; }
            else if (/^(sdh|hi|cc)$/.test(tok))                   { /* so marcador */ }
            else { break; }                        // token que nao e idioma -> faz parte do nome
            n = n.slice(0, m.index);
        }
        return { key: n.toLowerCase(), lang: lang, forced: forced };
    }

    function indexFolder(dir) {
        dir.listFiles(function (files) {
            map = {};
            for (var i = 0; i < files.length; i++) {
                if (files[i].isDirectory || !SUB_RE.test(files[i].name)) { continue; }
                var p = parse(files[i].name), uri;
                try { uri = files[i].toURI(); } catch (e) { continue; }
                (map[p.key] = map[p.key] || []).push({
                    name: files[i].name, uri: uri, lang: p.lang, forced: p.forced
                });
            }
            console.log('[subs] indexado:', Object.keys(map).length, 'videos com legenda em /subs');
            loading = false;
        }, function (e) {
            console.warn('[subs] erro ao ler /subs:', e && e.message);
            map = {}; loading = false;
        });
    }

    /* videoName = nome COMPLETO do arquivo de video (com extensao) */
    function get(videoName) {
        if (!map) { return []; }
        return map[String(videoName).toLowerCase()] || [];
    }
    function ready() { return map !== null; }

    return { load: load, get: get, ready: ready };
})();


/* ============================================================================
 * 5. UI  (renderizacao das duas areas: Continuar Assistindo + Navegacao)
 * ==========================================================================*/

var UI = (function () {

    var el = {
        usbStatus:   document.getElementById('usb-status'),
        continueSec: document.getElementById('continue-section'),
        continueList:document.getElementById('continue-list'),
        breadcrumb:  document.getElementById('breadcrumb'),
        fileList:    document.getElementById('file-list'),
        homeScreen:  document.getElementById('home-screen'),
        playerScreen:document.getElementById('player-screen'),
        playerUi:    document.getElementById('player-ui'),
        nowPlaying:  document.getElementById('now-playing'),
        progFill:    document.getElementById('progress-fill'),
        tCur:        document.getElementById('time-current'),
        tTot:        document.getElementById('time-total'),
        btnPlay:     document.getElementById('btn-playpause'),
        btnRewind:   document.getElementById('btn-rewind'),
        btnForward:  document.getElementById('btn-forward'),
        btnNext:     document.getElementById('btn-next'),
        btnStop:     document.getElementById('btn-stop'),
        nowSub:      document.getElementById('now-sub'),
        scrub:       document.getElementById('p-scrub'),
        knob:        document.getElementById('p-knob'),
        buf:         document.getElementById('p-buf'),
        preview:     document.getElementById('p-preview'),
        pCenter:     document.getElementById('p-center'),
        pCenterSvg:  document.getElementById('p-center-svg'),
        pGear:       document.getElementById('p-gear'),
        pSettings:   document.getElementById('p-settings'),
        setAudio:    document.getElementById('set-audio'),
        setText:     document.getElementById('set-text'),
        spinner:     document.getElementById('spinner'),
        nextToast:   document.getElementById('next-toast'),
        nextToastNm: document.getElementById('next-toast-name'),
        nextToastTitle: document.getElementById('next-toast-title'),
        skipBtn:     document.getElementById('skip-btn')
    };

    function setUsbStatus(text, cls) {
        el.usbStatus.textContent = text;
        el.usbStatus.className = 'usb-status' + (cls ? ' ' + cls : '');
    }

    function validDur(ms) { return ms > 0 && ms < 4294967000; }

    function hashHue(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
        return Math.abs(h) % 360;
    }

    /* extrai temporada/episodio do nome do arquivo */
    function epInfo(name) {
        var m = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/.exec(name);
        if (m) { return { s: +m[1], e: +m[2] }; }
        m = /(\d{1,2})\s*x\s*(\d{1,3})/.exec(name);                 // 1x02
        if (m) { return { s: +m[1], e: +m[2] }; }
        m = /epis[oó]dio\s*(\d{1,3})/i.exec(name) || /\bep\.?\s*(\d{1,3})\b/i.exec(name);
        if (m) { return { e: +m[1] }; }
        m = /temporada\s*(\d{1,2})/i.exec(name);
        if (m) { return { s: +m[1] }; }
        return null;
    }
    /* rotulo curto: "T1 E2" / "E2" / "T1" */
    function epLabel(name) {
        var i = epInfo(name);
        if (!i) { return null; }
        return (i.s ? 'T' + i.s + (i.e != null ? ' ' : '') : '') +
               (i.e != null ? 'E' + i.e : '');
    }
    /* frase para o subtitulo: "Temporada 1 - Episodio 2" */
    function epPhrase(name) {
        var i = epInfo(name);
        if (!i || i.e == null) { return null; }
        return (i.s ? 'Temporada ' + i.s + ' • ' : '') + 'Episodio ' + i.e;
    }

    var JUNK = /\b(1080p|720p|2160p|480p|4k|uhd|hdr10?|sdr|x264|x265|h ?264|h ?265|hevc|avc|aac|ac3|eac3|dd5 ?1|dts|web ?-? ?dl|web ?rip|bluray|blu ?ray|bdrip|hdrip|dvdrip|hdtv|remux|dual|dublado|legendado|leg|nacional|multi|10bit|8bit|proper|repack|amzn|nf|max|hmax|dsnp|atvp|hulu)\b/gi;

    /* nome limpo p/ exibir: tira tags, brackets, SxxExx, separadores, sites */
    function cleanName(name) {
        var raw = String(name).replace(/\.[^.]+$/, '');                  // extensao
        var s = raw;
        s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');     // [..] (..)
        s = s.replace(/[._]+/g, ' ');
        // corta a partir de marcadores de site/fonte
        s = s.replace(/[\s\-]+(www\S*|bludv\S*|comando\S*|torrent\S*|lapumia|rede ?canais|s[eé]ries ?flix|the ?pirate|yts|rarbg|galaxy ?tv|anim[ea]s? ?online|animestc|anitube|ondereto)\b.*$/i, '');
        s = s.replace(/[sS]\d{1,2}[\s\-]*[eE]\d{1,3}/g, ' ');            // S01E02
        s = s.replace(/\b\d{1,2}\s*x\s*\d{1,3}\b/g, ' ');               // 1x02
        s = s.replace(/\bepis[oó]dio\s*\d{1,3}/ig, ' ');
        s = s.replace(/\bep\.?\s*\d{1,3}\b/ig, ' ');
        s = s.replace(/\b[eE]\d{1,3}\b/g, ' ');                         // E12 solto
        s = s.replace(/\b\d+[ªa]?\s*temporada\b/ig, ' ');
        s = s.replace(/\btemporada\s*\d{1,2}/ig, ' ');
        s = s.replace(/\b(19|20)\d{2}\b/g, ' ');                        // ano
        s = s.replace(/\b[2457]\s*[.\s]\s*[01]\b/g, ' ');               // audio 5.1 / 2 0
        s = s.replace(JUNK, ' ');
        s = s.replace(/(^|\s)[\-–]+(?=\s|$)/g, ' ');                    // hifens orfaos
        s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–]+|[\s\-–]+$/g, '').trim();
        return s || raw;
    }

    /* monta um card unificado (usado nos trilhos e na grade) */
    function buildCard(opt) {
        // opt: { path, index, isDir, title, sub, thumbUrl, glyph, badge,
        //        watched, progressPct, onActivate, extraClass }
        var li = document.createElement(opt.li ? 'li' : 'div');
        li.className = 'card ' + (opt.isDir ? 'is-dir' : 'is-file') +
                       (opt.watched ? ' watched' : '') +
                       (opt.extraClass ? ' ' + opt.extraClass : '') + ' focusable';
        li.tabIndex = 0;
        if (opt.path  != null) { li.dataset.path  = opt.path; }
        if (opt.index != null) { li.dataset.index = opt.index; }

        var hue = hashHue(opt.title || 'x');
        var artStyle = opt.isDir ? '' :
            'background:linear-gradient(150deg,hsl(' + hue + ',34%,24%),hsl(' +
            ((hue + 40) % 360) + ',30%,12%))';

        var inner = '<div class="art" style="' + artStyle + '">';
        inner += '<img class="art-img" alt="">';
        inner += '<span class="art-glyph">' + (opt.glyph ||
                 (opt.isDir ? '&#128193;' : '&#127916;')) + '</span>';
        if (opt.badge)  { inner += '<span class="art-badge">' + escapeHtml(opt.badge) + '</span>'; }
        if (opt.watched){ inner += '<span class="art-check">&#10003;</span>'; }
        if (opt.progressPct > 0) {
            inner += '<div class="art-bar"><i style="width:' +
                     Math.max(2, Math.min(100, opt.progressPct)) + '%"></i></div>';
        }
        inner += '</div>';
        inner += '<div class="card-title">' + escapeHtml(opt.title || '') + '</div>';
        inner += '<div class="card-sub">' + (opt.sub || '') + '</div>';
        li.innerHTML = inner;

        if (opt.thumbUrl) { setThumb(li.querySelector('.art-img'), opt.thumbUrl, opt.isDir); }
        li.addEventListener('click', opt.onActivate);
        return li;
    }

    function setThumb(img, uri, isDirThumb) {
        if (!img || !uri || img.getAttribute('src')) { return; }
        img.onload  = function () {
            img.classList.add('loaded');
            /* pasta com capa real: o card acompanha o formato natural da capa
               (geralmente retrato) em vez do 16:9 forcado - sem precisar de
               fundo desfocado pra preencher */
            if (isDirThumb && img.parentElement) { img.parentElement.classList.add('poster-thumb'); }
        };
        img.onerror = function () { img.classList.remove('loaded'); img.removeAttribute('src'); };
        img.src = uri;
    }

    /* nome da serie a partir do caminho do arquivo (pasta pai = "Serie - N Temporada").
       Usado tanto no titulo do player (guessShow) quanto pra agrupar o
       "Continuar assistindo" por serie, ignorando a temporada. */
    function seriesNameFromPath(path) {
        var parts = String(path || '').replace(/\\/g, '/').split('/');
        var parent = parts[parts.length - 2] || '';
        parent = parent.replace(/\s*-\s*\d+[ªa]?\s*Temporada.*$/i, '').trim();
        return (parent && parent.toLowerCase() !== 'series' && parent.toLowerCase() !== 'animes'
                && parent.toLowerCase() !== 'filmes') ? parent : '';
    }

    /* Uma serie pode ter um episodio em andamento em mais de uma temporada
       (ex.: terminou a T1 mas o ultimo episodio nao bateu o limiar de
       "assistido", e ja comecou a T2) - sem isso apareceriam 2 cards de
       "continuar assistindo" pra mesma serie. Mantem so o mais recente por
       serie (a lista ja vem ordenada por 'updated' desc). Filmes/arquivos
       soltos (sem serie detectavel) nunca sao agrupados entre si. */
    function dedupeContinueBySeries(items) {
        var out = [], seen = {};
        for (var i = 0; i < items.length; i++) {
            var r = items[i];
            var key = seriesNameFromPath(r.path).toLowerCase();
            if (key) {
                if (seen.hasOwnProperty(key)) { continue; }
                seen[key] = true;
            }
            out.push(r);
        }
        return out;
    }

    /* --- Continuar assistindo (trilho) --- */
    function renderContinue() {
        var items;
        try { items = dedupeContinueBySeries(ProgressStore.continueList()).slice(0, 12); }
        catch (e) { console.error('[continue] erro:', e && e.message); items = []; }
        console.log('[continue] itens em progresso:', items.length);
        el.continueList.innerHTML = '';
        if (!items.length) { el.continueSec.classList.add('hidden'); return; }
        el.continueSec.classList.remove('hidden');

        items.forEach(function (r) {
            var pct = validDur(r.duration) ? Math.round((r.position / r.duration) * 100) : 0;
            var cx  = ContentIndex.get(r.path);
            var tc  = Thumbs.get(r.path);
            var phrase = epPhrase(r.name);
            var left = validDur(r.duration)
                ? fmtTime(r.duration - r.position) + ' restantes'
                : (phrase || 'continuar');
            var card = buildCard({
                path: r.path,
                title: (cx && cx.title) || cleanName(r.name),
                sub: left,
                thumbUrl: ThumbsFolder.get(baseName(r.path)) ||
                          (tc && tc.u) || (cx && cx.thumb) || null,
                badge: epLabel(r.name),
                progressPct: pct,
                extraClass: 'is-continue',
                onActivate: function () { openVideoByPath(r.path, r.position); }
            });
            card.setAttribute('data-hold', '');
            card._onHold = function () { ContextMenu.open(r.path); };
            el.continueList.appendChild(card);
        });
    }

    /* --- Breadcrumb --- */
    function renderBreadcrumb() {
        var parts = App.dirStack.concat(App.currentDir ? [App.currentDir] : []);
        el.breadcrumb.innerHTML = parts.map(function (d, i) {
            var last = (i === parts.length - 1);
            var label = d.name || d.path || 'USB';
            return '<span class="crumb' + (last ? ' current' : '') + '">' +
                   escapeHtml(label) + '</span>' +
                   (last ? '' : '<span class="sep">&rsaquo;</span>');
        }).join('');
    }

    /* --- Grade de arquivos --- */
    function renderFileList(entries) {
        el.fileList.innerHTML = '';
        if (!entries.length) {
            el.fileList.innerHTML = '<li class="empty">Pasta vazia.</li>';
            return;
        }
        var dirName_ = App.currentDir && App.currentDir.name;
        entries.forEach(function (e, i) {
            var isDir = e.isDir;
            var rec   = isDir ? null : ProgressStore.get(e.file.fullPath);
            var cx    = ContentIndex.get(isDir ? '' : e.file.fullPath);
            var th    = isDir ? ThumbsFolder.get(e.name)
                              : (ThumbsFolder.get(e.name) ||
                                 Thumbs.quick(e, App.dirImages, dirName_));
            var tcache= isDir ? null : Thumbs.get(e.file.fullPath);

            var durMs = 0;
            if (tcache && validDur(tcache.d)) { durMs = tcache.d; }
            else if (rec && validDur(rec.duration)) { durMs = rec.duration; }
            else if (cx && validDur(cx.duration)) { durMs = cx.duration; }

            var phrase = isDir ? null : epPhrase(e.name);
            var pct = 0, sub;
            if (isDir) { sub = ''; }
            else if (rec && rec.done) { sub = 'Assistido' + (phrase ? ' • ' + phrase : ''); }
            else if (rec && rec.position > 3000 && validDur(rec.duration)) {
                pct = Math.round((rec.position / rec.duration) * 100);
                sub = 'Continuar • ' + fmtTime(rec.duration - rec.position) + ' restantes';
            }
            else if (phrase) { sub = phrase; }
            else if (durMs) { sub = fmtTime(durMs); }
            else if (e.size) { sub = fmtSize(e.size); }
            else { sub = ''; }

            // badge no canto: duracao (filme) ou T1E2 (episodio)
            var epl = isDir ? null : epLabel(e.name);
            var badge = isDir ? null : (epl || (durMs ? fmtTime(durMs) : null));

            var title = isDir ? e.name
                      : (cx && cx.title ? cx.title : cleanName(e.name));

            var li = buildCard({
                li: true, index: i, isDir: isDir,
                path: e.file.fullPath,
                title: title,
                sub: sub,
                thumbUrl: th,
                badge: badge,
                watched: !!(rec && rec.done),
                progressPct: pct,
                onActivate: function () { onEntryActivate(i); }
            });
            el.fileList.appendChild(li);
        });
    }

    function findByPath(container, path) {
        var list = container.querySelectorAll('.card'), i;
        for (i = 0; i < list.length; i++) {
            if (list[i].dataset.path === path) { return list[i]; }
        }
        return null;
    }

    /* resultado tardio (miniatura de capa / duracao) -> atualiza o card */
    function applyThumb(path, r) {
        if (!r) { return; }
        [findByPath(el.fileList, path), findByPath(el.continueList, path)]
        .forEach(function (card) {
            if (!card) { return; }
            if (r.u) { setThumb(card.querySelector('.art-img'), r.u); }
            if (validDur(r.d) && !card.querySelector('.art-badge') && !card.classList.contains('is-dir')) {
                var b = document.createElement('span');
                b.className = 'art-badge'; b.textContent = fmtTime(r.d);
                card.querySelector('.art').appendChild(b);
            }
        });
    }

    function decorateCards() {
        var cards = el.fileList.querySelectorAll('.card.is-file');
        Array.prototype.forEach.call(cards, function (card) {
            var cx = ContentIndex.get(card.dataset.path);
            if (cx && validDur(cx.duration) && !card.querySelector('.art-badge')) {
                var b = document.createElement('span');
                b.className = 'art-badge'; b.textContent = fmtTime(cx.duration);
                card.querySelector('.art').appendChild(b);
            }
        });
    }

    /* a pasta /thumbs terminou de indexar -> aplica capa nos cards visiveis */
    function refreshThumbs() {
        var all = document.querySelectorAll('.card');
        var n = 0;
        Array.prototype.forEach.call(all, function (card) {
            var img = card.querySelector('.art-img');
            if (!img || img.classList.contains('loaded')) { return; }
            // pasta -> capa da serie pelo nome da pasta; arquivo -> pelo nome do arquivo
            var uri = ThumbsFolder.get(baseName(card.dataset.path));
            if (uri) { setThumb(img, uri, card.classList.contains('is-dir')); n++; }
        });
        console.log('[thumbs] refresh aplicou', n, 'capas');
    }

    /* --- Player: icones SVG --- */
    var ICON = {
        rewind:  '<path d="M12.5 8V4.5L7 10l5.5 5.5V12A6 6 0 1 1 6.5 18H4a8 8 0 1 0 8.5-10z"/>' +
                 '<text x="12.7" y="14.6" font-size="6.5" font-weight="700" text-anchor="middle">10</text>',
        forward: '<path d="M11.5 8V4.5L17 10l-5.5 5.5V12A6 6 0 1 0 17.5 18H20a8 8 0 1 1-8.5-10z"/>' +
                 '<text x="11.3" y="14.6" font-size="6.5" font-weight="700" text-anchor="middle">10</text>',
        play:    '<path d="M8 5v14l11-7z"/>',
        pause:   '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
        next:    '<path d="M6 5.5v13L15 12 6 5.5zM16.5 5.5v13H19v-13h-2.5z"/>',
        stop:    '<path d="M7 7h10v10H7z"/>',
        gear:    '<path d="M19.4 13c.04-.32.06-.66.06-1s-.02-.68-.07-1l2.1-1.6a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.3 7.3 0 0 0-1.7-.98l-.38-2.65A.49.49 0 0 0 13.5 1h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.6.24-1.17.57-1.7.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L3.66 11c-.05.32-.07.66-.07 1s.02.68.07 1L1.56 14.6a.5.5 0 0 0-.12.64l2 3.46c.14.24.42.34.68.22l2.49-1c.53.4 1.1.74 1.7.98l.38 2.65c.04.24.25.42.49.42h4c.24 0 .45-.18.49-.42l.38-2.65c.6-.24 1.17-.57 1.7-.98l2.49 1c.26.12.54.02.68-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM11.5 15.5A3.5 3.5 0 1 1 15 12a3.5 3.5 0 0 1-3.5 3.5z"/>'
    };
    function svg(paths, size) {
        return '<svg viewBox="0 0 24 24" width="' + (size || 30) + '" height="' + (size || 30) +
               '" fill="currentColor" aria-hidden="true">' + paths + '</svg>';
    }
    function initIcons() {
        el.btnRewind.innerHTML  = svg(ICON.rewind);
        el.btnForward.innerHTML = svg(ICON.forward);
        el.btnNext.innerHTML    = svg(ICON.next);
        el.btnStop.innerHTML    = svg(ICON.stop);
        el.pGear.innerHTML      = svg(ICON.gear);
        setPlayLabel(false);
        // ao terminar o flash de "voltando", esconde; se estiver pausado (stay), mantem
        el.pCenter.addEventListener('animationend', function () {
            if (!el.pCenter.classList.contains('stay')) {
                el.pCenter.hidden = true;
                el.pCenter.classList.remove('flash');
            }
        });
    }

    /* --- Player --- */
    function showPlayer(name) {
        var ep = epLabel(name);
        el.nowSub.textContent = ep ? (guessShow(name) ? guessShow(name) + '  ·  ' + ep : ep) : '';
        el.nowPlaying.textContent = cleanName(name);
        Screens.go('player');
        hideNextToast();
        el.pCenter.hidden = true;
        el.pCenter.classList.remove('flash', 'stay');
        fadeUi(false);
    }
    function guessShow(name) {
        return seriesNameFromPath(App.playingPath);
    }
    /* chamado ao voltar para a tela inicial (Screens 'home', enter com isBack) */
    function showHome() {
        el.pCenter.hidden = true;
        el.pCenter.classList.remove('flash', 'stay');
        renderContinue();
        renderFileList(App.dirFiles);
        Nav.focusFirst('files');
    }
    function updateProgress(pos, dur) {
        el.tTot.textContent = fmtTime(dur);
        if (el.scrub.classList.contains('scrubbing')) { return; }   // previa manda
        var pct = dur > 0 ? Math.max(0, Math.min(100, (pos / dur) * 100)) : 0;
        el.progFill.style.width = pct + '%';
        el.knob.style.left = pct + '%';
        el.tCur.textContent = fmtTime(pos);
    }
    function setBuffered(pct) { if (el.buf) { el.buf.style.width = Math.max(0, Math.min(100, pct)) + '%'; } }

    function setPlayLabel(paused) {
        el.btnPlay.innerHTML = svg(paused ? ICON.play : ICON.pause, 40);
        el.btnPlay.setAttribute('aria-label', paused ? 'Reproduzir' : 'Pausar');
    }
    function pulseCenter(paused) {
        el.pCenter.classList.remove('flash', 'stay');
        el.pCenterSvg.innerHTML = paused ? ICON.play : ICON.pause;
        el.pCenter.hidden = false;
        void el.pCenter.offsetWidth;          // reinicia a animacao
        // pausado: icone de play fica na tela; voltando: flash rapido e some
        el.pCenter.classList.add(paused ? 'stay' : 'flash');
    }
    function setSeekMode(on) { el.scrub.classList.toggle('seeking', !!on); }

    function fadeUi(faded) { el.playerUi.classList.toggle('faded', faded); }
    function showSpinner(on) { el.spinner.classList.toggle('hidden', !on); }

    /* --- Pular abertura / encerramento --- */
    var skipTarget = 0, skipShown = false;

    function updateSkip(posMs, durMs) {
        if (!App.skip || durMs <= 0) { if (skipShown) { hideSkip(); } return; }
        var sec = posMs / 1000, dur = durMs / 1000, seg = null, key = null;

        var op = App.skip.op, ed = App.skip.ed;
        if (op && !App.skipDone.op && sec >= Math.max(op[0], 1.5) && sec < op[1] - 0.5) {
            seg = op; key = 'op';
        } else if (ed && !App.skipDone.ed && sec >= ed[0] && sec < ed[1] - 0.5) {
            seg = ed; key = 'ed';
        }

        if (seg) {
            var target = Math.min(seg[1], dur - 3);     // nunca pula pros ultimos 3s
            if (target <= sec + 1) { hideSkip(); return; }
            if (!skipShown || skipTarget !== Math.round(target)) {
                el.skipBtn.textContent = (key === 'op') ? 'Pular abertura' : 'Pular encerramento';
                el.skipBtn.dataset.key = key;
                skipTarget = Math.round(target);
                el.skipBtn.hidden = false;
                skipShown = true;
                if (PlayerHud.mode && PlayerHud.mode() !== 'controls') { el.skipBtn.focus(); }
            }
        } else if (skipShown) {
            hideSkip();
        }
    }

    function hideSkip() {
        if (!skipShown) { return; }
        skipShown = false;
        el.skipBtn.hidden = true;
        if (document.activeElement === el.skipBtn && el.skipBtn.blur) { el.skipBtn.blur(); }
    }

    function doSkip() {
        if (!skipShown) { return false; }
        var k = el.skipBtn.dataset.key || 'op';
        App.skipDone[k] = true;
        Player.seekTo(skipTarget * 1000);
        hideSkip();
        PlayerHud.wake();
        return true;
    }

    function skipVisible() { return skipShown; }

    /* --- Card "Proximo episodio" ao comecar os creditos ---
     * Momento: 1) fim do encerramento (ed) de anime, 2) cr[0] detectado por
     * detectar-creditos.ps1, 3) padrao: 45 s antes do fim. Sem autoplay: o card
     * espera OK (assistir) ou ▲ (ocultar); o autoplay de 5 s continua so no fim. */
    var creditsShown = false, creditsDismissed = false;

    function creditsStart(durSec) {
        var s = App.skip, at = null;
        if (s && s.ed && s.ed[1] > durSec - 240 && s.ed[1] < durSec - 5) { at = s.ed[1]; }
        else if (s && s.cr && s.cr[0] > durSec * 0.5 && s.cr[0] < durSec - 5) { at = s.cr[0]; }
        else { at = Math.max(durSec - 45, durSec * 0.9); }
        return Math.min(at, durSec - 10);
    }

    function updateCredits(posMs, durMs) {
        if (durMs <= 0 || !App.nextEp) { return; }
        var sec = posMs / 1000, at = creditsStart(durMs / 1000);
        if (sec < at - 3) {                                   // voltou antes dos creditos
            creditsDismissed = false;
            if (creditsShown) { hideNextToast(); }
            return;
        }
        if (creditsShown || creditsDismissed || sec < at || sec >= durMs / 1000 - 0.5) { return; }
        var next = App.nextEp;
        creditsShown = true;
        hideSkip();
        showNextToast(next, function () { playNextEpisode(true); }, true);
    }

    function creditsVisible() { return creditsShown; }
    function dismissCredits() { creditsDismissed = true; hideNextToast(); }
    function resetCredits() { creditsShown = false; creditsDismissed = false; }

    /* --- Painel de audio e legendas --- */
    var settingsShown = false;

    function optEl(label, on, onclick) {
        var d = document.createElement('div');
        d.className = 'p-set-opt focusable' + (on ? ' on' : '');
        d.tabIndex = 0;
        d.innerHTML = '<span class="p-check">&#10003;</span><span>' + escapeHtml(label) + '</span>';
        d.addEventListener('click', onclick);
        return d;
    }
    function trackText(t, i, word) {
        var base = langName(t.lang, word + ' ' + (i + 1));
        return t.label && t.label.toLowerCase() !== base.toLowerCase()
             ? base + '  —  ' + t.label : base;
    }
    function buildSettings() {
        var a = el.setAudio, s = el.setText;
        if (!a || !s) { return; }
        a.innerHTML = ''; s.innerHTML = '';

        var audio = App.tracks.audio;
        if (audio.length <= 1) {
            a.appendChild(optEl(audio[0] ? langName(audio[0].lang, 'Original') : 'Original', true, function () {}));
        } else {
            audio.forEach(function (t, i) {
                a.appendChild(optEl(trackText(t, i, 'Faixa'), t.index === App.trackSel.audio,
                    function () { Player.selectAudio(t.index); buildSettings(); Nav.focusFirst('settings'); }));
            });
        }

        s.appendChild(optEl('Desligado', App.trackSel.text === -1,
            function () { Player.selectText(-1); buildSettings(); Nav.focusFirst('settings'); }));
        App.tracks.text.forEach(function (t, i) {
            s.appendChild(optEl(trackText(t, i, 'Legenda'), t.index === App.trackSel.text,
                function () { Player.selectText(t.index); buildSettings(); Nav.focusFirst('settings'); }));
        });
        (App.extSubs || []).forEach(function (xs, i) {
            var only = App.extSubs.length === 1;
            var lbl  = xs.lang ? ('Arquivo · ' + langName(xs.lang, xs.lang))
                     : only    ? 'Legenda do arquivo (.srt)' : ('Arquivo ' + (i + 1));
            if (xs.forced) { lbl += ' — forçada'; }
            s.appendChild(optEl(lbl, App.trackSel.text === (-2 - i),
                (function (idx) {
                    return function () { Player.selectText(idx); buildSettings(); Nav.focusFirst('settings'); };
                })(-2 - i)));
        });
    }
    function openSettings() {
        buildSettings();
        el.pSettings.hidden = false;
        settingsShown = true;
        Layers.open('settings');
        UI.fadeUi(false);
        Nav.setGroup('settings');
        Nav.focusFirst('settings');
    }
    function closeSettings() {
        el.pSettings.hidden = true;
        settingsShown = false;
        Layers.close('settings', true);
        Nav.setGroup('player');
        if (el.pGear.blur) { el.pGear.blur(); }
        PlayerHud.wake();
    }
    function settingsOpen() { return settingsShown; }

    /* previa de scrub (segurar ESQ/DIR) */
    function showPreview(sec) {
        if (sec == null) { el.scrub.classList.remove('scrubbing'); return; }
        var dur = Player.getDuration() / 1000;
        var pct = dur > 0 ? Math.max(0, Math.min(100, (sec / dur) * 100)) : 0;
        el.knob.style.left = pct + '%';
        el.progFill.style.width = pct + '%';
        el.preview.textContent = fmtTime(sec * 1000);
        el.scrub.classList.add('scrubbing');
    }

    var AUTOPLAY_SECS  = 5;
    var RING_R         = 17;
    var RING_C         = 2 * Math.PI * RING_R;
    var nextToastInterval = null;
    var btnToastPlay  = document.getElementById('btn-toast-play');
    var ringFill      = document.getElementById('toast-ring-fill');
    var ringNum       = document.getElementById('next-toast-secs');

    function clearNextToastTimer() {
        if (nextToastInterval) { clearInterval(nextToastInterval); nextToastInterval = null; }
    }

    function hideNextToast() {
        clearNextToastTimer();
        creditsShown = false;
        el.nextToast.classList.add('hidden');
        if (document.activeElement === btnToastPlay && btnToastPlay.blur) { btnToastPlay.blur(); }
    }

    function showNextToast(entry, onPlay, atCredits) {
        var ep = epLabel(entry.name);
        el.nextToast.classList.toggle('credits', !!atCredits);
        if (!atCredits) { creditsShown = false; }
        el.nextToastTitle.textContent = atCredits ? 'Proximo episodio' : 'Reproduzindo a seguir';
        el.nextToastNm.textContent = cleanName(entry.name) + (ep ? '  •  ' + ep : '');
        el.nextToast.classList.remove('hidden');
        var btnPlay   = btnToastPlay;
        var btnCancel = document.getElementById('btn-toast-cancel');
        var secsLeft  = AUTOPLAY_SECS;

        clearNextToastTimer();

        if (atCredits) {                       // sem contagem: espera OK / ▲
            btnPlay.onclick = function () { hideNextToast(); onPlay(); };            return;
        }

        // reseta o anel pro estado "cheio" sem animar, depois liga a transicao
        ringFill.style.transition = 'none';
        ringFill.style.strokeDashoffset = '0';
        ringNum.textContent = secsLeft;
        ringFill.getBoundingClientRect(); // forca reflow
        ringFill.style.transition = 'stroke-dashoffset 1s linear';

        btnPlay.onclick   = function () { hideNextToast(); onPlay(); };
        btnCancel.onclick = function () { hideNextToast(); goHome(); };

        nextToastInterval = setInterval(function () {
            secsLeft--;
            if (secsLeft <= 0) {
                hideNextToast();
                onPlay();
            } else {
                ringNum.textContent = secsLeft;
                ringFill.style.strokeDashoffset =
                    (RING_C * (AUTOPLAY_SECS - secsLeft) / AUTOPLAY_SECS) + '';
            }
        }, 1000);

        Nav.focusFirst('toast');
    }

    /* aviso curto: elemento proprio (#app-toast), fora das telas - nao mexe
       no card de proximo episodio nem no estado dele (creditsShown etc.) */
    var appToast = document.getElementById('app-toast'), appToastTimer = null;
    function toast(msg) {
        appToast.textContent = msg;
        appToast.hidden = false;
        if (appToastTimer) { clearTimeout(appToastTimer); }
        appToastTimer = setTimeout(function () { appToastTimer = null; appToast.hidden = true; }, 3500);
    }

    return {
        setUsbStatus: setUsbStatus, renderContinue: renderContinue,
        renderBreadcrumb: renderBreadcrumb, renderFileList: renderFileList,
        decorateCards: decorateCards, applyThumb: applyThumb,
        refreshThumbs: refreshThumbs,
        cleanName: cleanName, epLabel: epLabel,
        showPlayer: showPlayer, showHome: showHome, updateProgress: updateProgress,
        setPlayLabel: setPlayLabel, fadeUi: fadeUi, showSpinner: showSpinner,
        initIcons: initIcons, setSeekMode: setSeekMode, pulseCenter: pulseCenter,
        setBuffered: setBuffered, showPreview: showPreview,
        buildSettings: buildSettings, openSettings: openSettings,
        closeSettings: closeSettings, settingsOpen: settingsOpen,
        updateSkip: updateSkip, hideSkip: hideSkip, doSkip: doSkip, skipVisible: skipVisible,
        updateCredits: updateCredits, creditsVisible: creditsVisible,
        dismissCredits: dismissCredits, resetCredits: resetCredits,
        showNextToast: showNextToast, hideNextToast: hideNextToast, toast: toast, el: el
    };
})();


/* ============================================================================
 * 6. NAVEGACAO POR CONTROLE REMOTO (D-pad)
 *    Motor de foco em js/nav.js; aqui so os grupos desta tela.
 * ==========================================================================*/

Nav.define('continue', { type: 'rail', down: 'files' });
Nav.define('files',    { type: 'grid', up: 'continue' });
Nav.define('settings', { type: 'col' });
Nav.define('toast',    { type: 'row' });
Nav.define('ctx',      { type: 'row' });
Nav.define('player',   { type: 'row', items: function () {
    var out = Array.prototype.slice.call(document.querySelectorAll('.p-controls .focusable'));
    var gear = document.getElementById('p-gear');      // engrenagem no topo, por ultimo
    if (gear) { out.push(gear); }
    return out;
} });


/* ---------------------------------------------------------------------------
 * Teclas: registra as de midia e trata o keydown global.
 * -------------------------------------------------------------------------*/
var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    RETURN: 10009, PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252,
    STOP: 413, FF: 417, REW: 412,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
};

function registerRemoteKeys() {
    if (window.tizen && tizen.tvinputdevice) {
        ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
         'MediaFastForward', 'MediaRewind',
         'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'
        ].forEach(function (k) {
            try { tizen.tvinputdevice.registerKey(k); } catch (e) {}
        });
    }
}

/* --- HUD do player: modo 'seek' (some em 4s) x modo 'controls' (botoes) --- */
var PlayerHud = (function () {
    var t = null, mode = 'seek';

    function wake() {
        UI.fadeUi(false);
        if (t) { clearTimeout(t); t = null; }
        if (mode === 'seek' && !Player.isPaused()) {
            t = setTimeout(function () { UI.fadeUi(true); }, 4000);
        }
    }
    function toControls() {
        mode = 'controls';
        if (t) { clearTimeout(t); t = null; }
        UI.setSeekMode(false);
        UI.fadeUi(false);
        Nav.setGroup('player');
        Nav.focusFirst('player');
    }
    function toSeek() {
        mode = 'seek';
        var a = document.activeElement;
        if (a && a.blur) { a.blur(); }
        UI.setSeekMode(true);
        wake();
    }
    function reset() { mode = 'seek'; UI.setSeekMode(true); wake(); }
    return {
        wake: wake, toControls: toControls, toSeek: toSeek, reset: reset,
        mode: function () { return mode; },
        isFaded: function () { return UI.el.playerUi.classList.contains('faded'); }
    };
})();

/* --- Segurar ESQ/DIR = varredura acelerada com previa (estilo streaming) --- */
var Scrub = (function () {
    var active = false, sec = 0, presses = 0, tAuto = null;
    function step(dir) {
        if (!active) { active = true; presses = 0; sec = Player.getPosition() / 1000; }
        presses++;
        var d = presses < 4 ? 10 : (presses < 9 ? 30 : 60);
        var dur = Player.getDuration() / 1000;
        sec = Math.max(0, Math.min(dur - 2, sec + dir * d));
        UI.showPreview(sec);
        PlayerHud.wake();
        clearTimeout(tAuto);
        tAuto = setTimeout(commit, 900);        // se o keyup nao vier
    }
    function commit() {
        if (!active) { return; }
        active = false;
        clearTimeout(tAuto);
        Player.seekTo(Math.round(sec * 1000));
        UI.showPreview(null);
        PlayerHud.wake();
    }
    return { step: step, commit: commit, isActive: function () { return active; } };
})();

/* Teclas: globais -> camada aberta do topo (Layers) -> tela atual (Screens) */
function onKeyDown(ev) {
    var code = ev.keyCode;
    if (code === KEY.GREEN) { DebugLog.toggle(); return; }
    if (code === KEY.ENTER && Nav.holding()) { return; }   // OK segurado: so o keyup conta
    if (Layers.onKey(code, ev)) { return; }
    Screens.onKey(code, ev);
}

function onKeyUp(ev) {
    if ((ev.keyCode === KEY.LEFT || ev.keyCode === KEY.RIGHT) && Scrub.isActive()) {
        Scrub.commit(); return;
    }
    if (ev.keyCode === KEY.ENTER) { Nav.okUp(); }     // toque curto num card com data-hold
}

/* ---------------- TELA INICIAL (Continuar assistindo + pastas) ---------------- */
function homeKeys(code) {
    switch (code) {
        case KEY.LEFT:  Nav.move('left');  break;
        case KEY.RIGHT: Nav.move('right'); break;
        case KEY.UP:    Nav.move('up');    break;
        case KEY.DOWN:  Nav.move('down');  break;
        case KEY.ENTER: Nav.okDown();      break;   // segurar OK no Continuar = opcoes
        case KEY.STOP:
        case KEY.RETURN: goUpDirectory();  break;
        case KEY.RED:   scanUsb();         break;
        case KEY.BLUE:  NetUpload.toggleStatus(); break;
    }
    return true;
}

/* ---------------- PLAYER ---------------- */
function playerKeys(code) {
    Player.poke();                       // retomada presa sem eventos/timers: a tecla destrava
    // parar/voltar funciona sempre
    if (code === KEY.STOP || code === KEY.RETURN) { stopAndGoHome(); return true; }

    var ctrl = (PlayerHud.mode() === 'controls');

    // botao "Pular abertura" visivel: OK pula direto (mesmo com a HUD escondida),
    // desde que o foco nao esteja nos controles da barra
    if (UI.skipVisible() && !ctrl && code === KEY.ENTER) { UI.doSkip(); return true; }

    // card "Proximo episodio" nos creditos: OK assiste, ▲ oculta
    if (UI.creditsVisible() && !ctrl) {
        if (code === KEY.ENTER) { playNextEpisode(true); return true; }
        if (code === KEY.UP)    { UI.dismissCredits(); return true; }
    }

    // 1a tecla quando a HUD esta escondida: so revela (exceto play/pause)
    if (PlayerHud.isFaded() && !UI.skipVisible() &&
        code !== KEY.PLAY && code !== KEY.PAUSE && code !== KEY.PLAYPAUSE) {
        PlayerHud.wake(); return true;
    }
    PlayerHud.wake();
    switch (code) {
        case KEY.YELLOW: UI.openSettings(); break;
        case KEY.LEFT:  ctrl ? Nav.move('left')  : Scrub.step(-1); break;
        case KEY.RIGHT: ctrl ? Nav.move('right') : Scrub.step(1);  break;
        case KEY.DOWN:  if (!ctrl) { PlayerHud.toControls(); } break;
        case KEY.UP:    if (ctrl)  { PlayerHud.toSeek(); }     break;
        case KEY.ENTER: ctrl ? Nav.activate() : togglePlayFromRemote(); break;
        case KEY.PLAY:
        case KEY.PAUSE:
        case KEY.PLAYPAUSE: togglePlayFromRemote(); break;
        case KEY.FF:  Player.seekBy(85000);  break;
        case KEY.REW: Player.seekBy(-85000); break;
    }
    return true;
}

Screens.register('home', {
    el: document.getElementById('home-screen'),
    enter: function (params, isBack) { if (isBack) { UI.showHome(); } },
    onKey: homeKeys
});
Screens.register('player', {
    el: document.getElementById('player-screen'),
    onKey: playerKeys
});

/* painel de audio e legendas (camada por cima do player) */
Layers.register('settings', { onKey: function (code) {
    switch (code) {
        case KEY.UP:    Nav.move('up');   break;
        case KEY.DOWN:  Nav.move('down'); break;
        case KEY.ENTER: Nav.activate();   break;
        case KEY.STOP:
        case KEY.RETURN: UI.closeSettings(); break;
    }
} });

function togglePlayFromRemote() {
    var paused = Player.togglePlay();
    UI.setPlayLabel(paused);
    UI.pulseCenter(paused);
    PlayerHud.wake();
}


/* ============================================================================
 * 7. FLUXO PRINCIPAL
 * ==========================================================================*/

function boot() {
    Player.init();
    registerRemoteKeys();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    console.log('[boot] AmorecoFlix iniciado. tizen=' + (!!window.tizen) +
               ' webapis=' + (!!window.webapis));
    logCssSupport();
    Screens.go('home');

    // liga botoes do player
    document.getElementById('btn-playpause').onclick = togglePlayFromRemote;
    document.getElementById('btn-rewind').onclick    = function () { Player.seekBy(-10000); };
    document.getElementById('btn-forward').onclick   = function () { Player.seekBy(10000); };
    document.getElementById('btn-stop').onclick      = stopAndGoHome;
    document.getElementById('btn-next').onclick      = playNextEpisode;
    document.getElementById('skip-btn').onclick      = function () { UI.doSkip(); };
    document.getElementById('p-gear').onclick        = function () { UI.openSettings(); };
    UI.initIcons();

    // ao focar um card de video sem miniatura, gera a dele com prioridade
    var focusTimer = null;
    UI.el.fileList.addEventListener('focus', function (ev) {
        var card = ev.target;
        if (!card.classList || !card.classList.contains('is-file')) { return; }
        clearTimeout(focusTimer);
        focusTimer = setTimeout(function () {
            var e = App.dirFiles[card.dataset.index | 0];
            if (e && !e.isDir) {
                var c = Thumbs.get(e.file.fullPath);
                if (!c || !c.d) {
                    Thumbs.probeDuration(e, function (r) { UI.applyThumb(e.file.fullPath, r); });
                }
            }
        }, 400);
    }, true);

    // salva progresso (e grava no HD) se o app for para segundo plano / fechar
    function saveNow() { Player.saveProgress(); ProgressStore.flush(); }
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { saveNow(); }
    });
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('blur', saveNow);
    window.addEventListener('pagehide', saveNow);

    // detecta USB conectado/removido em tempo real
    if (window.tizen && tizen.filesystem && tizen.filesystem.addStorageStateChangeListener) {
        tizen.filesystem.addStorageStateChangeListener(function (storage) {
            console.log('[USB] mudou:', storage.label, storage.state);
            scanUsb();
        });
    }

    UI.renderContinue();
    ContentIndex.query(function () { UI.renderContinue(); });
    scanUsb();
    NetUpload.startAutoConnect();
}

function scanUsb() {
    UI.setUsbStatus('Procurando HD USB...');
    mapUsb(function (storages) {
        if (!storages.length) {
            UI.setUsbStatus('Nenhum HD USB detectado. Conecte e pressione VERMELHO.', 'error');
            UI.renderFileList([]);
            return;
        }
        resolveStorage(storages[0].label, function (rootDir) {
            App.dirStack = [];
            // procura a pasta "AmorecoFlix" na raiz e entra nela
            rootDir.listFiles(function (files) {
                var lib = null;
                for (var i = 0; i < files.length; i++) {
                    if (files[i].isDirectory &&
                        files[i].name.toLowerCase() === LIBRARY_DIR.toLowerCase()) {
                        lib = files[i]; break;
                    }
                }
                var base = lib || rootDir;
                App.libraryDir = base;
                UI.setUsbStatus(lib ? ('Biblioteca: ' + LIBRARY_DIR)
                                    : ('Pasta "' + LIBRARY_DIR + '" nao encontrada no HD.'),
                                lib ? 'ok' : 'error');
                ThumbsFolder.load(base, true);      // true = reindexa (capas/legendas/skip novos)
                SkipData.load(base, true);
                SubsFolder.load(base, true);
                ProgressStore.loadFromDisk(base);
                enterDirectory(base);
            }, function (err) {
                UI.setUsbStatus('Falha ao ler o HD: ' + (err && err.message), 'error');
            });
        }, function (err) {
            UI.setUsbStatus('Falha ao abrir o HD: ' + (err && err.message), 'error');
        });
    });
}

function enterDirectory(dir) {
    App.currentDir = dir;
    UI.renderBreadcrumb();
    listDirectory(dir, function (entries, images, subs) {
        App.dirFiles  = entries;
        App.dirImages = images || [];
        App.dirSubs   = subs || {};
        UI.renderFileList(entries);
        // reescaneio (USB/NetUpload) durante o video: atualiza a grade, mas
        // nao rouba o foco do player
        if (!isPlayerActive()) { Nav.focusFirst('files'); }

        // titulos/duracao do indice da TV (thumb geralmente vem null, sem problema)
        ContentIndex.query(function () {
            UI.decorateCards();
            UI.renderContinue();
        });

        // duracao das primeiras faixas (a miniatura de video da preto nessa TV)
        entries.filter(function (e) { return !e.isDir; }).slice(0, 10)
            .forEach(function (e) {
                var c = Thumbs.get(e.file.fullPath);
                if (!c || !c.d) {
                    Thumbs.probeDuration(e, function (r) { UI.applyThumb(e.file.fullPath, r); });
                }
            });
    });
}

function onEntryActivate(index) {
    var entry = App.dirFiles[index];
    if (!entry) { return; }
    if (entry.isDir) {
        App.dirStack.push(App.currentDir);
        enterDirectory(entry.file);
    } else {
        App.playlist = App.dirFiles.filter(function (e) { return !e.isDir; });
        openVideo(entry, savedPosition(entry));
    }
}

function goUpDirectory() {
    if (App.dirStack.length) {
        var parent = App.dirStack.pop();
        enterDirectory(parent);
    }
}

/* --- abertura de video --- */

function isPlayerActive() { return UI.el.playerScreen.classList.contains('active'); }

function openVideo(entry, resumeMs) {
    // abrindo o 1o episodio da proxima temporada: a playlist passa a ser a pasta dela
    if (App.nextSeason && entry === App.nextSeason.entry) { App.playlist = App.nextSeason.list; }
    App.nextSeason = null;
    App.playingPath  = entry.file.fullPath;
    App.skip = SkipData.get(entry.name);          // { op:[s,e], ed:[s,e] } ou null
    App.skipDone = {};                             // intervalos ja pulados nesta sessao
    App.nextEp = findNextEpisode(App.playingPath); // p/ o card ao comecar os creditos
    if (!App.nextEp) {                             // ultimo da pasta: tenta a proxima temporada
        var path = App.playingPath;
        findNextSeason(path, function (first, list) {
            if (App.playingPath !== path) { return; }
            App.nextSeason = { entry: first, list: list };
            App.nextEp = first;
            console.log('[Next] proxima temporada:', first.name);
        });
    }
    UI.resetCredits();
    App.extSubs = findExtSubs(entry.name);         // legendas da pasta central /subs
    UI.hideSkip();
    UI.closeSettings();
    UI.showPlayer(entry.name);
    UI.showSpinner(true);
    Player.load(entry.file.toURI(), resumeMs, onVideoEnded);
    UI.setPlayLabel(false);
    Nav.setGroup('player');
    PlayerHud.reset();
}

/* legendas externas do episodio: pasta central /subs (fallback: ao lado do video).
 * Retorna [{name,uri,lang,forced}] ordenado (PT nao-forcada primeiro). */
function findExtSubs(videoName) {
    var list = SubsFolder.get(videoName);

    if ((!list || !list.length) && App.dirSubs) {           // fallback legado
        var b = stripExt(videoName).toLowerCase()
                  .replace(/\.(pt|pt-br|por|eng|en|forced|hi|sdh)$/i, '');
        var near = App.dirSubs[b];
        if (near && near.length) {
            list = near.map(function (s) {
                var uri = ''; try { uri = s.file.toURI(); } catch (e) {}
                return {
                    name: s.name, uri: uri,
                    lang: /\b(pt|por|portugu)/i.test(s.name) ? 'pt'
                        : /\b(en|eng|ingl)/i.test(s.name)    ? 'en' : '',
                    forced: /forced/i.test(s.name)
                };
            });
        }
    }

    list = (list || []).filter(function (s) { return s.uri; });
    list.sort(function (a, b) { return rank(a) - rank(b); });
    return list;

    function rank(s) {
        if (s.lang === 'pt' && !s.forced) { return 0; }
        if (s.lang === 'pt') { return 1; }
        if (!s.lang && !s.forced) { return 2; }
        if (!s.forced) { return 3; }
        return 4;
    }
}

/* Reabre pelo path salvo (usado na aba Continuar Assistindo). */
function openVideoByPath(fullPath, resumeMs) {
    // tenta achar na playlist atual; senao resolve direto pelo caminho
    var dirVideos = App.dirFiles.filter(function (e) { return !e.isDir; });
    var inList = dirVideos.filter(function (e) {
        return e.file.fullPath === fullPath;
    })[0];
    if (inList) { App.playlist = dirVideos; openVideo(inList, resumeMs); return; }

    tizen.filesystem.resolve('file://' + fullPath, function (file) {
        var pseudo = { file: file, name: file.name, isDir: false };
        App.playlist = [pseudo];
        // monta a playlist da pasta do arquivo: sem isso nao existe "proximo episodio"
        // (card dos creditos / autoplay) quando se entra por "Continuar assistindo"
        var parent = null;
        try { parent = file.parent; } catch (e) {}
        if (!parent) { openVideo(pseudo, resumeMs); return; }
        listDirectory(parent, function (entries) {
            var list = entries.filter(function (e) { return !e.isDir; });
            var cur = list.filter(function (e) { return e.file.fullPath === fullPath; })[0];
            if (cur) { App.playlist = list; openVideo(cur, resumeMs); }
            else     { openVideo(pseudo, resumeMs); }
        });
    }, function (err) {
        UI.toast('Arquivo nao encontrado. O USB foi removido?');
    });
}

/* ponto salvo de um episodio (0 se nunca abriu ou ja foi assistido) - sem
 * isso o proximo episodio abria do zero e apagava o progresso dele */
function savedPosition(entry) {
    var rec = ProgressStore.get(entry.file.fullPath);
    return (rec && !rec.done) ? (rec.position || 0) : 0;
}

function onVideoEnded() {
    var next = findNextEpisode(App.playingPath);
    if (next) {
        UI.showNextToast(next, function () { openVideo(next, savedPosition(next)); });
    } else {
        stopAndGoHome();
    }
}

function playNextEpisode(fromCredits) {
    var next = findNextEpisode(App.playingPath);
    if (next) {
        var prev = App.playingPath;
        Player.stop();
        if (fromCredits === true) { ProgressStore.markComplete(prev); }   // viu ate os creditos
        openVideo(next, savedPosition(next));
    }
    else { UI.toast('Este e o ultimo episodio da pasta.'); }
}

function stopAndGoHome() {
    UI.hideNextToast();
    Player.stop(true);
    goHome();
}
function goHome() {
    UI.hideNextToast();
    Nav.setGroup('files');
    Screens.backTo('home');
    NetUpload.kickReconnect();
}

/* ============================================================================
 * 7b. MENU DE CONTEXTO  (segurar OK sobre "Continuar assistindo")
 * ==========================================================================*/

var ContextMenu = (function () {
    var box    = document.getElementById('ctx-menu');
    var title  = document.getElementById('ctx-title');
    var bPlay   = document.getElementById('ctx-play');
    var bRemove = document.getElementById('ctx-remove');
    var bCancel = document.getElementById('ctx-cancel');
    var open_   = false;

    function open(path) {
        var rec = ProgressStore.get(path);
        if (!rec) { return; }
        var ep = UI.epLabel(rec.name);
        title.textContent = UI.cleanName(rec.name) + (ep ? '  •  ' + ep : '');
        box.hidden = false;
        open_ = true;
        Layers.open('ctx');

        bPlay.onclick = function () {
            close();
            openVideoByPath(path, rec.position || 0);
        };
        bRemove.onclick = function () {
            ProgressStore.remove(path);
            close();
            UI.renderContinue();
        };
        bCancel.onclick = close;

        Nav.setGroup('ctx');
        Nav.focusFirst('ctx');
    }

    function close() {
        box.hidden = true;
        open_ = false;
        Layers.close('ctx', true);
        if (document.querySelector('[data-nav-group="continue"] .card')) {
            Nav.setGroup('continue');
            Nav.focusFirst('continue');
        } else {
            Nav.setGroup('files');
            Nav.focusFirst('files');
        }
    }

    function isOpen() { return open_; }

    Layers.register('ctx', { onKey: function (code) {
        switch (code) {
            case KEY.LEFT:  Nav.move('left');  break;
            case KEY.RIGHT: Nav.move('right'); break;
            case KEY.ENTER: Nav.activate();    break;
            case KEY.STOP:
            case KEY.RETURN: close(); break;
        }
    } });

    return { open: open, close: close, isOpen: isOpen };
})();


/* ============================================================================
 * 8. HELPERS
 * ==========================================================================*/

function fmtTime(ms) {
    if (!ms || ms < 0) { return '00:00'; }
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(ss);
}
function fmtSize(bytes) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(1) + ' ' + u[i];
}
function baseName(p) { return p.split('/').pop(); }
function dirName(p)  { return p.slice(0, p.lastIndexOf('/')); }

/* Le um arquivo de texto do HD (UTF-8, sem BOM). Sempre pela funcao
 * top-level tizen.filesystem.resolve(caminho completo) - File.resolve() de
 * instancia trava nessa TV. onMissing recebe o erro (ausente/ilegivel). */
function readTextFile(fullPath, onText, onMissing) {
    function miss(e) { if (onMissing) { onMissing(e); } }
    try {
        tizen.filesystem.resolve(fullPath, function (f) {
            f.openStream('r', function (s) {
                var txt = '';
                try { txt = s.read(s.bytesAvailable || 5000000); } catch (e) {}
                try { s.close(); } catch (e) {}
                onText(String(txt).replace(/^\uFEFF/, ''));
            }, miss, 'UTF-8');
        }, miss, 'r');
    } catch (e) { miss(e); }
}
/* URL de um arquivo do HD para <img> etc. (o simulador troca por http) */
function fileUrl(fullPath) {
    return window.__fileUrl ? window.__fileUrl(fullPath) : 'file://' + fullPath;
}

/* recursos de CSS que o layout novo usa - o navegador da TV ja mostrou que
 * nao tem 'inset'; o resultado vai pro log (tecla VERDE / amorecoflix.log) */
function logCssSupport() {
    if (!window.CSS || !CSS.supports) { console.log('[css] CSS.supports indisponivel'); return; }
    var tests = {
        gap: 'display:flex;gap:1px', inset: 'inset:0', aspect: 'aspect-ratio:1/1',
        clamp: '-webkit-line-clamp:2', objectFit: 'object-fit:cover', fontVar: 'font-variant-numeric:tabular-nums'
    };
    var out = [];
    for (var k in tests) {
        if (!tests.hasOwnProperty(k)) { continue; }
        var parts = tests[k].split(';'), ok = true;
        parts.forEach(function (d) { var i = d.indexOf(':'); ok = ok && CSS.supports(d.slice(0, i), d.slice(i + 1)); });
        out.push(k + '=' + (ok ? 'sim' : 'NAO'));
    }
    console.log('[css] ' + out.join(' ') + ' | ' + navigator.userAgent.replace(/^.*?\(/, '('));
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
}


/* ============================================================================
 * NETUPLOAD - conecta sozinho no PC em segundo plano e recebe arquivos
 * grandes por WebSocket, gravando no HD. O PC escolhe a pasta de destino
 * (consulta a arvore da biblioteca por esse mesmo canal) - a TV nao precisa
 * de nenhuma acao manual. Tecla AZUL (fora do player) so mostra/esconde um
 * status rapido, ou cancela uma transferencia em andamento.
 *
 * IMPORTANTE: so funciona fora da tela do player. Player.init()/AVPlay
 * quebra os timers e callbacks assincronos genericos (setTimeout, XHR,
 * WebSocket) nessa TV - so os callbacks nativos do tizen.filesystem
 * continuam funcionando depois disso. Testado e confirmado em Set/2026.
 * Por seguranca, alem do setInterval de reconexao, forcamos uma tentativa
 * de reconexao toda vez que o usuario volta pra tela inicial (goHome()).
 *
 * Protocolo (texto = JSON, binario = pedaco de arquivo):
 *   TV -> PC  {type:'hello'}                          ao conectar
 *   PC -> TV  {type:'list', reqId, path}               path relativo a AmorecoFlix ('' = raiz)
 *   TV -> PC  {type:'listing', reqId, path, entries:[{name,isDir}]}
 *   TV -> PC  {type:'listing-error', reqId, message}
 *   PC -> TV  {type:'mkdir', reqId, path}
 *   TV -> PC  {type:'mkdir-ok'|'mkdir-error', reqId, message}
 *   PC -> TV  {type:'meta', reqId, path, name, size}   inicia transferencia
 *   TV -> PC  {type:'ready', reqId}                    arquivo criado, pronto p/ bytes
 *   PC -> TV  <binario> x N                            pedacos do arquivo, em ordem
 *   PC -> TV  {type:'end', reqId}                      fim dos dados
 *   TV -> PC  {type:'done', reqId}                      escrita+fechamento confirmados
 *   TV -> PC  {type:'error', reqId, message}            erro em qualquer etapa
 * ==========================================================================*/
var NetUpload = (function () {
    var CFG_DEFAULT = { pcIp: '192.168.0.3', port: 8788 };
    var box    = document.getElementById('net-upload');
    var status = document.getElementById('net-upload-status');
    var fill   = document.getElementById('net-upload-fill');
    var pct    = document.getElementById('net-upload-pct');

    var ws = null, connected = false, connecting = false, reconnectTimer = null;
    var stream = null, fileObj = null;
    var xferReqId = null, received = 0, total = 0, fileName = '', xferActive = false;
    var statusToastOn = false;

    function setStatus(text) { status.textContent = text; }
    function setProgress(p, sizeText) {
        var v = Math.max(0, Math.min(100, p));
        fill.style.width = v + '%';
        pct.textContent = v.toFixed(1) + '%' + (sizeText ? ' - ' + sizeText : '');
    }
    function showToast(text) {
        setStatus(text);
        setProgress(0);
        box.hidden = false;
        statusToastOn = true;
    }
    function hideToast() {
        box.hidden = true;
        statusToastOn = false;
    }

    /* config opcional em AmorecoFlix/netupload.json (sobrescreve IP/porta) */
    function loadConfig(cb) {
        if (!App.libraryDir || !App.libraryDir.fullPath) { cb(CFG_DEFAULT); return; }
        readTextFile(App.libraryDir.fullPath + '/netupload.json', function (text) {
            try {
                var cfg = JSON.parse(text);
                cb({ pcIp: cfg.pcIp || CFG_DEFAULT.pcIp, port: cfg.port || CFG_DEFAULT.port });
            } catch (e) { cb(CFG_DEFAULT); }
        }, function () { cb(CFG_DEFAULT); });
    }

    function reply(obj) { try { if (ws) { ws.send(JSON.stringify(obj)); } } catch (e) {} }

    /* ---- conexao / reconexao ---- */
    function ensureConnecting() {
        if (connected || connecting) { return; }
        connecting = true;
        loadConfig(function (cfg) {
            var url = 'ws://' + cfg.pcIp + ':' + cfg.port;
            try {
                ws = new WebSocket(url);
                ws.binaryType = 'arraybuffer';
            } catch (e) { connecting = false; return; }
            ws.onopen = function () {
                connected = true; connecting = false;
                reply({ type: 'hello' });
            };
            ws.onerror = function () { connecting = false; };
            ws.onclose = function () {
                connected = false; connecting = false;
                if (xferActive) { abortTransfer('Conexao com o PC caiu no meio da transferencia.'); }
            };
            ws.onmessage = onMessage;
        });
    }

    function startAutoConnect() {
        ensureConnecting();
        if (reconnectTimer) { clearInterval(reconnectTimer); }
        reconnectTimer = setInterval(function () {
            if (!connected) { ensureConnecting(); }
        }, 5000);
    }

    /* chamado ao voltar pra tela inicial - reforca reconexao mesmo se o
       setInterval tiver parado de disparar por causa do player/AVPlay */
    function kickReconnect() {
        if (!connected) { ensureConnecting(); }
    }

    /* caminho/nome vindos do PC: nada de sair da biblioteca ("..", absoluto,
       barra invertida) nem nome com separador */
    function safeRel(p) {
        p = String(p || '');
        return p.charAt(0) !== '/' && p.indexOf('\\') === -1 &&
               !/(^|\/)\.\.?(\/|$)/.test(p);
    }
    function safeName(n) {
        n = String(n || '');
        return !!n && n !== '.' && n !== '..' && !/[\/\\]/.test(n);
    }

    /* ---- resolucao de caminho (sempre pela funcao top-level, nunca
       File.resolve() de instancia - trava nessa TV, ver memoria) ---- */
    function resolveRel(relPath, mode, cb, errCb) {
        if (!App.libraryDir || !App.libraryDir.fullPath) { errCb({ message: 'Biblioteca ainda nao carregada' }); return; }
        var full = App.libraryDir.fullPath + (relPath ? '/' + relPath : '');
        try { tizen.filesystem.resolve(full, cb, errCb, mode); } catch (e) { errCb(e); }
    }

    /* cria a pasta (e paes que faltarem) recursivamente */
    function mkdirp(relPath, cb, errCb) {
        var parts = String(relPath || '').split('/').filter(Boolean);
        function step(i) {
            if (i >= parts.length) {
                resolveRel(parts.join('/'), 'rw', cb, errCb);
                return;
            }
            var accum = parts.slice(0, i + 1).join('/');
            resolveRel(accum, 'rw', function () { step(i + 1); }, function () {
                var parentPath = parts.slice(0, i).join('/');
                resolveRel(parentPath, 'rw', function (parentDir) {
                    try {
                        parentDir.createDirectory(parts[i]);
                        step(i + 1);
                    } catch (e) { errCb(e); }
                }, errCb);
            });
        }
        if (!parts.length) { resolveRel('', 'rw', cb, errCb); return; }
        step(0);
    }

    /* ---- mensagens do PC ---- */
    function onMessage(ev) {
        if (typeof ev.data !== 'string') { writeChunk(ev.data); return; }
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        switch (msg.type) {
            case 'list':  handleList(msg);  break;
            case 'mkdir': handleMkdir(msg); break;
            case 'meta':  handleMeta(msg);  break;
            case 'end':   handleEnd(msg);   break;
        }
    }

    function handleList(msg) {
        if (!safeRel(msg.path)) { reply({ type: 'listing-error', reqId: msg.reqId, message: 'caminho invalido' }); return; }
        resolveRel(msg.path || '', 'r', function (dir) {
            dir.listFiles(function (files) {
                var entries = [];
                for (var i = 0; i < files.length; i++) {
                    var n = files[i].name;
                    if (n === 'thumbs' || n === 'subs' || n.charAt(0) === '.') { continue; }
                    entries.push({ name: n, isDir: !!files[i].isDirectory });
                }
                reply({ type: 'listing', reqId: msg.reqId, path: msg.path || '', entries: entries });
            }, function (e) {
                reply({ type: 'listing-error', reqId: msg.reqId, message: (e && e.message) || 'erro ao listar' });
            });
        }, function (e) {
            reply({ type: 'listing-error', reqId: msg.reqId, message: (e && e.message) || 'pasta nao encontrada' });
        });
    }

    function handleMkdir(msg) {
        if (!safeRel(msg.path)) { reply({ type: 'mkdir-error', reqId: msg.reqId, message: 'caminho invalido' }); return; }
        mkdirp(msg.path || '', function () {
            reply({ type: 'mkdir-ok', reqId: msg.reqId });
        }, function (e) {
            reply({ type: 'mkdir-error', reqId: msg.reqId, message: (e && e.message) || 'erro ao criar pasta' });
        });
    }

    /* modo de diagnostico: path '__NETTEST__' pula a escrita em disco de
       proposito (so conta os bytes recebidos e descarta) - serve pra medir
       a velocidade PURA da rede, isolada da escrita no HD da TV. Temporario,
       usado so pra achar o gargalo real da transferencia. */
    var netTestMode = false;

    function handleMeta(msg) {
        if (xferActive) {
            reply({ type: 'error', reqId: msg.reqId, message: 'Ja existe uma transferencia em andamento.' });
            return;
        }
        if (msg.path !== '__NETTEST__' && (!safeRel(msg.path) || !safeName(msg.name))) {
            reply({ type: 'error', reqId: msg.reqId, message: 'Caminho ou nome de arquivo invalido.' });
            return;
        }
        xferActive = true;
        xferReqId = msg.reqId;
        fileName = msg.name;
        total = msg.size;
        received = 0;
        bytesSinceOpen = 0;
        rotating = false;
        pendingChunks = [];
        pendingEnd = null;
        netTestMode = (msg.path === '__NETTEST__');
        if (netTestMode) {
            showToast('TESTE DE REDE (sem gravar): ' + fileName);
            reply({ type: 'ready', reqId: xferReqId });
            return;
        }
        showToast('Recebendo: ' + fileName);
        resolveRel(msg.path || '', 'rw', function (dir) {
            /* se ja existir um arquivo com esse nome (ex.: reenvio/regeracao
               de uma capa), apaga primeiro - createFile() recusa sobrescrever
               ("Overwrite is not allowed") */
            function create() {
                try {
                    fileObj = dir.createFile(fileName);
                    fileObj.openStream('w', function (s) {
                        stream = s;
                        reply({ type: 'ready', reqId: xferReqId });
                    }, function (e) {
                        failTransfer('Erro abrindo arquivo para escrita: ' + ((e && e.message) || e));
                    });
                } catch (e) {
                    failTransfer('Erro criando arquivo: ' + ((e && e.message) || e));
                }
            }
            var existingPath = dir.fullPath + '/' + fileName;
            try {
                tizen.filesystem.resolve(existingPath, function (existing) {
                    dir.deleteFile(existing.fullPath, create, function (e) {
                        failTransfer('Erro apagando arquivo existente: ' + ((e && e.message) || e));
                    });
                }, create, 'rw');
            } catch (e) { create(); }
        }, function (e) {
            failTransfer('Erro abrindo pasta de destino: ' + ((e && e.message) || e));
        });
    }

    /* fecha e reabre o arquivo (modo 'a') periodicamente durante a escrita.
       Motivo: um envio real de 1.6GB terminou "sem erro" (todos os bytes
       reportados como escritos) mas o arquivo simplesmente NAO EXISTIA
       depois - enquanto um teste de 300MB com o mesmo fluxo gravou certinho
       (conferido por listagem real + tamanho no disco). Ha algum limite/
       degradacao ao manter UM stream aberto por tempo/volume grande demais
       nessa TV. Reabrir a cada ~200MB evita isso, seja qual for a causa
       exata. Mensagens que chegam durante a rotacao (chunks ou o 'end')
       ficam em fila e sao processadas assim que o novo stream abre. */
    var ROTATE_BYTES = 200 * 1024 * 1024;
    var bytesSinceOpen = 0;
    var rotating = false;
    var pendingChunks = [];
    var pendingEnd = null;

    function writeChunk(buf) {
        if (netTestMode) {
            var n = (buf.byteLength !== undefined) ? buf.byteLength : buf.length;
            received += n;
            setProgress(total ? (received / total * 100) : 0, fmtSize(received) + ' / ' + fmtSize(total));
            return;
        }
        if (rotating) { pendingChunks.push(buf); return; }
        if (!stream) { return; }
        doWrite(buf);
    }

    /* o codigo original convertia CADA byte num loop for antes de chamar
       writeBytes() - o real gargalo da transferencia (CPU fraca da TV, bem
       mais lento que a rede). Aqui testamos se essa versao do Tizen aceita
       o Uint8Array direto (rapido, zero copia); se recusar, cai pro fallback
       Array.prototype.slice.call (copia nativa em C, ainda bem mais rapida
       que o for byte a byte). Decidido 1x no 1o pedaco e reaproveitado no
       resto da transferencia. */
    var directWriteOk = null;

    function doWrite(buf) {
        try {
            var u8 = new Uint8Array(buf);
            if (directWriteOk !== false) {
                try {
                    stream.writeBytes(u8);
                    directWriteOk = true;
                } catch (eDirect) { directWriteOk = false; }
            }
            if (directWriteOk === false) {
                stream.writeBytes(Array.prototype.slice.call(u8));
            }
            received += u8.length;
            bytesSinceOpen += u8.length;
            var sizeText = fmtSize(received) + (total ? ' / ' + fmtSize(total) : '');
            setProgress(total ? (received / total * 100) : 0, sizeText);
            if (bytesSinceOpen >= ROTATE_BYTES && received < total) {
                rotateStream();
            }
        } catch (e) {
            failTransfer('Erro escrevendo no HD: ' + ((e && e.message) || e));
        }
    }

    function rotateStream() {
        rotating = true;
        try { if (stream) { stream.close(); } } catch (e) {}
        stream = null;
        try {
            tizen.filesystem.resolve(fileObj.fullPath, function (f) {
                f.openStream('a', function (s) {
                    stream = s;
                    bytesSinceOpen = 0;
                    rotating = false;
                    flushPending();
                }, function (e) {
                    failTransfer('Erro reabrindo arquivo (rotacao de escrita): ' + ((e && e.message) || e));
                });
            }, function (e) {
                failTransfer('Erro reabrindo arquivo (rotacao de escrita): ' + ((e && e.message) || e));
            }, 'rw');
        } catch (e) {
            failTransfer('Erro reabrindo arquivo (rotacao de escrita): ' + ((e && e.message) || e));
        }
    }

    function flushPending() {
        while (pendingChunks.length && !rotating) {
            doWrite(pendingChunks.shift());
        }
        if (!rotating && !pendingChunks.length && pendingEnd) {
            var msg = pendingEnd;
            pendingEnd = null;
            handleEnd(msg);
        }
    }

    function handleEnd(msg) {
        if (netTestMode) {
            setStatus('Teste de rede concluido: ' + fmtSize(received));
            reply({ type: 'done', reqId: msg.reqId, actualSize: received, expectedSize: total });
            xferActive = false;
            return;
        }
        if (rotating || pendingChunks.length) { pendingEnd = msg; return; }
        try { if (stream) { stream.close(); } } catch (e) {}
        stream = null;
        var expectedTotal = total;
        var reportedName = fileName;
        var savedFileObj = fileObj;

        function finish(actualSize, verifyNote) {
            setProgress(100, fmtSize(expectedTotal) + ' / ' + fmtSize(expectedTotal));
            setStatus((verifyNote ? verifyNote : 'Concluido: ' + reportedName));
            reply({ type: 'done', reqId: msg.reqId, actualSize: actualSize, expectedSize: expectedTotal });
            xferActive = false;
            fileObj = null;
            if (App.currentDir) { enterDirectory(App.currentDir); }
        }

        /* verifica de verdade o tamanho gravado no disco antes de dizer que
           deu certo - ja vimos um caso onde a escrita "sem erro" nao bateu
           com o tamanho real gravado apos uma transferencia longa/grande */
        if (savedFileObj && savedFileObj.fullPath) {
            try {
                tizen.filesystem.resolve(savedFileObj.fullPath, function (f) {
                    var actualSize = f.fileSize;
                    if (actualSize !== expectedTotal) {
                        finish(actualSize, 'ALERTA: gravou ' + fmtSize(actualSize) + ' de ' + fmtSize(expectedTotal) + ' esperado - ' + reportedName);
                    } else {
                        finish(actualSize, null);
                    }
                }, function (e) {
                    finish(-1, 'ALERTA: arquivo NAO encontrado apos gravar - ' + reportedName + ' (' + ((e && e.message) || e) + ')');
                }, 'r');
            } catch (e) {
                finish(-1, 'ALERTA: erro verificando arquivo apos gravar - ' + ((e && e.message) || e));
            }
        } else {
            finish(-1, null);
        }
    }

    function failTransfer(message) {
        setStatus(message);
        reply({ type: 'error', reqId: xferReqId, message: message });
        cleanupFailedTransfer();
    }

    function abortTransfer(message) {
        setStatus(message);
        cleanupFailedTransfer();
    }

    function cleanupFailedTransfer() {
        try { if (stream) { stream.close(); } } catch (e) {}
        if (fileObj) {
            var toDelete = fileObj;
            try {
                tizen.filesystem.resolve(dirName(toDelete.fullPath), function (dir) {
                    dir.deleteFile(toDelete.fullPath, function () {}, function () {});
                }, function () {}, 'rw');
            } catch (e) {}
        }
        xferActive = false;
        stream = null; fileObj = null;
    }

    /* tecla AZUL: mostra status rapido (conectado/reconectando) quando
       ocioso, ou cancela quando ha uma transferencia ativa */
    function toggleStatus() {
        if (xferActive) {
            reply({ type: 'error', reqId: xferReqId, message: 'Cancelado pelo usuario na TV.' });
            cleanupFailedTransfer();
            hideToast();
            return;
        }
        if (statusToastOn) { hideToast(); return; }
        kickReconnect();
        showToast(connected ? 'PC conectado.' : 'Sem conexao com o PC - tentando reconectar...');
    }

    return {
        startAutoConnect: startAutoConnect,
        kickReconnect: kickReconnect,
        toggleStatus: toggleStatus,
        isOpen: function () { return xferActive; }
    };
})();

/* ============================================================================
 * START
 * ==========================================================================*/
window.onload = boot;
