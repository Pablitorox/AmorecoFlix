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

    function fmt(a) {
        try { return (a && typeof a === 'object') ? JSON.stringify(a) : String(a); }
        catch (e) { return '' + a; }
    }
    function push(tag, args) {
        var t = new Date().toTimeString().slice(0, 8);
        lines.push(t + ' [' + tag + '] ' +
            Array.prototype.map.call(args, fmt).join(' '));
        if (lines.length > 300) { lines.shift(); }
        if (visible) { render(); }
    }
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
    return { toggle: toggle, isOpen: function () { return visible; } };
})();

/* Extensoes de video reconhecidas na navegacao. */
var VIDEO_EXT = ['mp4', 'mkv', 'avi', 'mov', 'm4v', 'ts', 'webm', 'wmv', 'flv',
                 'mpg', 'mpeg', '3gp', 'm2ts', 'vob', 'ogv'];

/* Considera "assistido" quando passou de 92% da duracao. */
var COMPLETE_RATIO = 0.92;

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
    extSub:       null,     // URI da legenda externa preferida do episodio atual
    extSubs:      [],       // todas as legendas externas: [{name,uri,lang,forced}]
    dirFiles:     [],       // conteudo listado do diretorio atual
    dirImages:    [],       // imagens da pasta (usadas como capa)
    playlist:     [],       // apenas os videos do diretorio atual (ordenados)
    playingPath:  null,     // fullPath do video em reproducao
    playingIndex: -1,       // indice do video atual dentro de playlist
    usingAvplay:  false,    // true = AVPlay, false = fallback <video>
    saveTimer:    null
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

function isVideoFile(name) {
    var dot = name.lastIndexOf('.');
    if (dot < 0) { return false; }
    return VIDEO_EXT.indexOf(name.slice(dot + 1).toLowerCase()) !== -1;
}

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
    var seekTarget    = 0;        // alvo do ultimo seek (ms) - p/ reemitir se travar

    /* alguns arquivos tem um ponto que o AVPlay simplesmente recusa fazer
     * seek (PLAYER_ERROR_SEEK_FAILED mesmo com um ms valido - provavelmente
     * indice/keyframe quebrado nesse trecho do arquivo). Sem isso, cada
     * reabertura (automatica OU manual, via Continuar assistindo) tenta
     * retomar exatamente nesse mesmo ponto de novo e falha de novo. Lembra
     * o ultimo alvo que falhou p/ pular o seek e comecar do zero da proxima. */
    var lastFailedSeek = null;    // { uri, ms }
    function rememberFailedSeek(uri, ms) {
        if (uri && validMs(ms)) { lastFailedSeek = { uri: uri, ms: ms }; }
    }
    function seekKnownBad(uri, ms) {
        return !!lastFailedSeek && lastFailedSeek.uri === uri &&
               Math.abs(lastFailedSeek.ms - ms) < 5000;
    }

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
        if (seekKnownBad(fileUri, resumeMs)) {
            console.warn('[Player] pulando seek de retomada (ja falhou antes nesse ponto):', resumeMs);
            resumeMs = 0;
        }
        onEndedCb = onEnded || null;
        position  = 0;
        duration  = 0;
        isPaused  = false;
        reopenCount = 0;
        stallSince  = 0;
        stallStep   = 0;

        if (App.usingAvplay) {
            loadAvplay(fileUri);
        } else {
            html5.src = fileUri;
            html5.load();
        }
    }

    var pendingSeek = 0;      // seek de retomada, aplicado apos o 1o buffering
    var watchdog    = null;   // timeout de "loading travado"
    var started     = false;  // ja recebeu o 1o frame/playtime?

    function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

    var resumeSeekWatchdog = null;   // ver armResumeWatchdog()
    function clearResumeWatchdog() {
        if (resumeSeekWatchdog) { clearTimeout(resumeSeekWatchdog); resumeSeekWatchdog = null; }
    }
    /* O onerror do AVPlay para um seek de retomada ruim demorou de 1s a quase
     * 50s pra disparar em testes reais (provavelmente o player tenta de novo
     * sozinho por dentro antes de desistir e avisar). Em vez de depender
     * desse tempo incerto, desiste sozinho em 7s se a retomada nao confirmar
     * (oncurrentplaytime nao voltou perto do alvo) - marca o alvo como ruim
     * e reabre do zero, sem esperar o player. */
    function armResumeWatchdog(targetMs) {
        clearResumeWatchdog();
        resumeSeekWatchdog = setTimeout(function () {
            resumeSeekWatchdog = null;
            if (seekingUntil && seekTarget === targetMs) {
                console.warn('[Player] retomada nao confirmou em 7s, comecando do zero:', targetMs);
                rememberFailedSeek(currentUri, targetMs);
                seekingUntil = 0;
                resumeMs = 0;
                loadAvplay(currentUri);
            }
        }, 7000);
    }

    function loadAvplay(fileUri) {
        try { avplay.close(); } catch (e) {}
        clearResumeWatchdog();

        currentUri  = fileUri;
        started     = false;
        pendingSeek = (validMs(resumeMs) && resumeMs >= 1000) ? resumeMs : 0;
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
            },
            onbufferingcomplete: function ()   {
                UI.showSpinner(false);
                // fallback: se o seek de retomada ainda nao pegou (rebuffer tardio)
                if (pendingSeek && duration > 0 && pendingSeek < duration - 2000) {
                    var s = pendingSeek;
                    try { avplay.seekTo(s); } catch (e) {}
                }
            },
            onstreamcompleted:   function ()   { clearWatchdog(); handleEnded(); },
            onerror: function (err) {
                clearWatchdog();
                console.error('[AVPlay] erro:', err);
                UI.showSpinner(false);
                saveProgress();                       // nao perde o ponto atual
                // erro bateu com um seek de retomada em andamento: provavelmente
                // e o proprio alvo que o AVPlay esta recusando (indice/keyframe
                // quebrado nesse ponto do arquivo) - guarda p/ a proxima abertura
                // (automatica OU manual, via Continuar assistindo) pular esse seek
                // e comecar do zero, em vez de repetir a mesma falha sem parar.
                if (Date.now() < seekingUntil && seekTarget) {
                    rememberFailedSeek(currentUri, seekTarget);
                }
                if (started && reopenCount < 2) {     // tenta reabrir
                    reopenCount++;
                    resumeMs = seekKnownBad(currentUri, position) ? 0 : position;
                    UI.toast('Recuperando a reproducao...');
                    loadAvplay(currentUri);
                } else {
                    UI.toast('Erro ao reproduzir: ' + (err && err.message || err));
                }
            },
            oncurrentplaytime: function (ms) {
                if (!started && ms > 0) {           // 1o frame renderizado
                    started = true;
                    clearWatchdog();
                    UI.showSpinner(false);
                }
                if (seekingUntil && ms > 0 &&
                    (!seekTarget || ms > seekTarget || Math.abs(ms - seekTarget) < 12000)) {
                    seekingUntil = 0;              // seek concluiu, playtime voltou
                    stallSince = 0;
                    clearResumeWatchdog();
                    UI.showSpinner(false);
                }
                if (pendingSeek) {
                    // seek inicial ignorado (comecou do zero) -> tenta 1x mais
                    if (started && ms > 0 && ms < 5000 && pendingSeek > 15000) {
                        var s = pendingSeek; pendingSeek = 0;
                        try { avplay.seekTo(s); } catch (e) {}
                        return;
                    }
                    // ja passou do ponto salvo (caiu no keyframe) -> retomada concluida
                    if (ms >= pendingSeek - 1500) { pendingSeek = 0; }
                }
                position = ms;
                UI.updateProgress(position, duration);
                UI.updateSkip(position, duration);
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
            // retomada: faz o seek AGORA (estado READY), antes do play().
            // onbufferingcomplete durante o prepare roda com duration=0 e nao seekava.
            if (pendingSeek && duration > 0 && pendingSeek < duration - 2000) {
                seekTarget = pendingSeek; seekingUntil = Date.now() + 20000;
                try { avplay.seekTo(pendingSeek); position = pendingSeek; }
                catch (e) { console.error('[AVPlay] seekTo inicial', e); }
                armResumeWatchdog(pendingSeek);
            } else {
                pendingSeek = 0;
            }
            UI.updateProgress(position, duration);
            try { avplay.play(); } catch (e) { console.error('[AVPlay] play()', e); }
            startTick();
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
        if (App.usingAvplay) {
            if (isPaused) { avplay.play(); } else { avplay.pause(); }
        } else {
            if (html5.paused) { html5.play(); } else { html5.pause(); }
        }
        isPaused = !isPaused;
        saveProgress();                       // grava sempre que pausa/despausa
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
        if (App.usingAvplay) {
            markSeek(target);
            try { avplay.seekTo(target); } catch (e) { console.error('[AVPlay] seekTo', e); }
        } else {
            html5.currentTime = target / 1000;
        }
        position = target;
    }

    function stop(saveFirst) {
        if (saveFirst !== false) { saveProgress(); }
        stopTick();
        clearWatchdog();
        clearResumeWatchdog();
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
        seekingUntil = 0;
        saveProgress();                        // grava logo o ponto inicial
        tickTimer = setInterval(function () {
            if (isPaused) { return; }
            saveProgress();
            checkStall();
        }, 3000);                              // grava / verifica a cada 3s
    }
    function stopTick() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    /* Detecta "congelou do nada": position parada por varios segundos com o
     * video tocando (e SEM seek em andamento). Escada de recuperacao, do mais
     * leve pro mais forte: reemite play/seek -> reabre no ponto -> desiste.
     * Nao usa pause()+play(): interrompe seek em curso e trava o AVPlay. */
    function checkStall() {
        if (!App.usingAvplay || !started) { return; }
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
            UI.toast('Recuperando a reproducao...');
            try {
                avplay.play();                            // reemite play
                if (seekTarget) { avplay.seekTo(seekTarget); }  // e o ultimo seek, se houver
            } catch (e) {}
        } else if (stallStep === 1 && stuck >= 22000) {
            stallStep = 2;
            if (currentUri && reopenCount < 2) {
                if (seekTarget) { rememberFailedSeek(currentUri, seekTarget); }
                reopenCount++;
                resumeMs = seekKnownBad(currentUri, position) ? 0 : position;
                loadAvplay(currentUri);        // reabre no ponto salvo (ou do zero, se o alvo e suspeito)
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
        selectAudio: selectAudio, selectText: selectText,
        getPosition: function () { return position; },
        getDuration: function () { return duration; },
        isPaused:    function () { return isPaused; }
    };
})();


/* ============================================================================
 * 3. PROGRESS STORE  (localStorage)
 *    Chave unica por arquivo (fullPath). Guarda posicao, duracao e "done".
 * ==========================================================================*/

/* ProgressStore - "Continuar assistindo".
 *
 * O localStorage sozinho NAO e confiavel aqui: ele fica dentro do sandbox do
 * app e ja se perdeu/voltou no tempo depois de reinstalacoes (aconteceu
 * durante os testes do NetUpload em Set/2026). Agora ele so serve de cache
 * rapido pro boot - a fonte de verdade e um arquivo de verdade no HD
 * (AmorecoFlix/progresso.json, mesmo padrao do skip.json), que sobrevive a
 * qualquer reinstalacao do app porque fica fora do sandbox dele. */
var ProgressStore = (function () {

    var KEY = 'meuplayer.progress.v1';
    var FILE_NAME = 'progresso.json';
    var cache = load();
    var libDir = null;
    var writing = false, pendingWrite = false;

    function load() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch (e) { return {}; }
    }
    function persistLocal() {
        try { localStorage.setItem(KEY, JSON.stringify(cache)); }
        catch (e) { console.error('[Store] localStorage cheio?', e); }
    }

    /* chamado 1x pelo scanUsb() assim que a pasta AmorecoFlix e encontrada -
       o arquivo no HD manda: se existir, substitui o que tiver no cache
       (inclusive o que veio do localStorage, que pode estar desatualizado) */
    function loadFromDisk(libraryDir) {
        libDir = libraryDir;
        if (!libDir || !libDir.fullPath) { return; }
        var path = libDir.fullPath + '/' + FILE_NAME;
        try {
            tizen.filesystem.resolve(path, function (f) {
                f.openStream('r', function (s) {
                    var txt = '';
                    try { txt = s.read(s.bytesAvailable || 5000000); } catch (e) {}
                    s.close();
                    try {
                        cache = JSON.parse(txt) || {};
                        persistLocal();
                        console.log('[Store] progresso carregado do HD (' + Object.keys(cache).length + ' itens)');
                        if (window.UI && UI.renderContinue) { UI.renderContinue(); }
                    } catch (e) { console.warn('[Store] progresso.json invalido:', e && e.message); }
                }, function () {}, 'UTF-8');
            }, function () {
                /* ainda nao existe no HD - se ja tem progresso local (versao
                   anterior a essa mudanca), migra pra ele agora */
                if (Object.keys(cache).length) { writeToDisk(); }
            }, 'r');
        } catch (e) { console.warn('[Store] erro lendo progresso.json:', e && e.message); }
    }

    function writeToDisk() {
        if (!libDir || !libDir.fullPath) { return; }
        if (writing) { pendingWrite = true; return; }
        writing = true;
        var json = JSON.stringify(cache);
        var path = libDir.fullPath + '/' + FILE_NAME;

        function afterWrite() {
            writing = false;
            if (pendingWrite) { pendingWrite = false; writeToDisk(); }
        }
        function doWrite(fileObj) {
            try {
                fileObj.openStream('w', function (s) {
                    try { s.write(json); } catch (e) {}
                    s.close();
                    afterWrite();
                }, function (e) {
                    console.warn('[Store] erro abrindo progresso.json p/ escrita:', e && e.message);
                    afterWrite();
                }, 'UTF-8');
            } catch (e) { console.warn('[Store] erro escrevendo progresso.json:', e && e.message); afterWrite(); }
        }
        try {
            tizen.filesystem.resolve(path, function (f) { doWrite(f); }, function () {
                try {
                    tizen.filesystem.resolve(libDir.fullPath, function (dir) {
                        doWrite(dir.createFile(FILE_NAME));
                    }, function (e) { console.warn('[Store] erro criando progresso.json:', e && e.message); afterWrite(); }, 'rw');
                } catch (e) { afterWrite(); }
            }, 'rw');
        } catch (e) { console.warn('[Store] erro geral escrevendo progresso.json:', e && e.message); afterWrite(); }
    }

    function persist() {
        persistLocal();
        writeToDisk();
    }

    /** Salva/atualiza o registro de um arquivo. */
    function save(rec) {
        cache[rec.path] = rec;
        persist();
    }

    /** Retorna o registro de um arquivo (ou null). */
    function get(path) {
        return cache[path] || null;
    }

    /** Marca como concluido e zera a posicao (para nao aparecer em "continuar"). */
    function markComplete(path) {
        if (cache[path]) {
            cache[path].done = true;
            cache[path].position = 0;
            cache[path].updated = Date.now();
            persist();
        }
    }

    /** Lista de itens NAO concluidos, mais recentes primeiro (aba Continuar Assistindo). */
    function continueList(limit) {
        var arr = [];
        for (var p in cache) {
            if (!cache.hasOwnProperty(p)) { continue; }
            var r = cache[p];
            if (!r.done && r.position >= 1000) { arr.push(r); }
        }
        arr.sort(function (a, b) { return b.updated - a.updated; });
        return limit ? arr.slice(0, limit) : arr;
    }

    function remove(path) { delete cache[path]; persist(); }
    function clearAll()   { cache = {}; persist(); }

    return {
        save: save, get: get, markComplete: markComplete,
        continueList: continueList, remove: remove, clearAll: clearAll,
        loadFromDisk: loadFromDisk
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

function findNextEpisode(currentPath) {
    if (!App.playlist.length) { return null; }

    var idx = App.playlist.findIndex(function (e) {
        return e.file.fullPath === currentPath;
    });
    if (idx === -1 || idx + 1 >= App.playlist.length) { return null; }

    var cur  = parseEpisode(App.playlist[idx].name);
    var next = App.playlist[idx + 1];

    // Se ambos seguem o padrao SxxEyy, confirma que e sequencia coerente.
    var nextEp = parseEpisode(next.name);
    if (cur && nextEp) {
        var sameSeasonNext = (nextEp.season === cur.season && nextEp.ep === cur.ep + 1);
        var newSeasonNext  = (nextEp.season === cur.season + 1);
        if (!sameSeasonNext && !newSeasonNext) {
            // fora do padrao esperado -> ainda assim oferece o proximo arquivo
            console.log('[Next] sequencia nao-linear, usando proximo por ordem.');
        }
    }
    return next;
}

function parseEpisode(name) {
    var m = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/.exec(name);
    if (!m) { return null; }
    return { season: parseInt(m[1], 10), ep: parseInt(m[2], 10) };
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

    /* mantido por compatibilidade - so consulta 1x, sem re-scan por pasta */
    function refresh(dirFile, done) { query(done); }

    function get(fullPath) { return map[key(fullPath)] || null; }

    return { refresh: refresh, query: query, get: get };
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

    function load(libDir) {
        if (map !== null || loading || !libDir || !libDir.listFiles) { return; }
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

    function load(libDir) {
        if (map !== null || !libDir || !libDir.resolve) { return; }
        try {
            libDir.resolve('skip.json', function (f) {
                f.openStream('r', function (s) {
                    var txt = s.read(s.bytesAvailable || 5000000);
                    s.close();
                    try {
                        var raw = JSON.parse(String(txt).replace(/^﻿/, '')), m = {};
                        for (var k in raw) { if (raw.hasOwnProperty(k)) { m[k.toLowerCase()] = raw[k]; } }
                        map = m;
                        console.log('[skip] skip.json:', Object.keys(map).length, 'episodios');
                    } catch (e) { console.warn('[skip] json invalido:', e && e.message); map = {}; }
                }, function () { map = {}; }, 'UTF-8');
            }, function () { console.log('[skip] skip.json ausente'); map = {}; });
        } catch (e) { map = {}; }
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

    function load(libDir) {
        if (map !== null || loading || !libDir || !libDir.listFiles) { return; }
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

    /* --- Continuar assistindo (trilho) --- */
    function renderContinue() {
        var items;
        try { items = ProgressStore.continueList(12); }
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
        el.homeScreen.classList.remove('active');
        el.playerScreen.classList.add('active');
        el.nextToast.classList.add('hidden');
        el.pCenter.hidden = true;
        el.pCenter.classList.remove('flash', 'stay');
        fadeUi(false);
    }
    function guessShow(name) {
        // pasta pai = nome da serie (se houver)
        var p = App.playingPath || '';
        var parts = p.replace(/\\/g, '/').split('/');
        var parent = parts[parts.length - 2] || '';
        parent = parent.replace(/\s*-\s*\d+[ªa]?\s*Temporada.*$/i, '').trim();
        return (parent && parent.toLowerCase() !== 'series' && parent.toLowerCase() !== 'animes'
                && parent.toLowerCase() !== 'filmes') ? parent : '';
    }
    function showHome() {
        el.playerScreen.classList.remove('active');
        el.homeScreen.classList.add('active');
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
        UI.fadeUi(false);
        Nav.setGroup('settings');
        Nav.focusFirst('settings');
    }
    function closeSettings() {
        el.pSettings.hidden = true;
        settingsShown = false;
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

    function showNextToast(entry, onPlay) {
        var ep = epLabel(entry.name);
        el.nextToastNm.textContent = cleanName(entry.name) + (ep ? '  •  ' + ep : '');
        el.nextToast.classList.remove('hidden');
        var btnPlay   = document.getElementById('btn-toast-play');
        var btnCancel = document.getElementById('btn-toast-cancel');
        btnPlay.onclick   = function () { el.nextToast.classList.add('hidden'); onPlay(); };
        btnCancel.onclick = function () { el.nextToast.classList.add('hidden'); goHome(); };
        Nav.focusFirst('toast');
    }

    function toast(msg) {
        el.nextToastNm.textContent = msg;
        el.nextToast.classList.remove('hidden');
        setTimeout(function () { el.nextToast.classList.add('hidden'); }, 3500);
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
        showNextToast: showNextToast, toast: toast, el: el
    };
})();


/* ============================================================================
 * 6. NAVEGACAO POR CONTROLE REMOTO (D-pad)
 * ==========================================================================*/

var Nav = (function () {

    var group = 'files';         // grupo focavel ativo

    function items(g) {
        var conts = document.querySelectorAll('[data-nav-group="' + g + '"]');
        var out = [];
        Array.prototype.forEach.call(conts, function (c) {
            out = out.concat(Array.prototype.slice.call(
                c.querySelectorAll('.focusable, .card')));
        });
        if (g === 'player') {
            var gear = document.getElementById('p-gear');   // engrenagem no topo
            if (gear) { out.push(gear); }
        }
        return out;
    }

    function focusFirst(g) {
        group = g;
        var list = items(g);
        if (list.length) { list[0].focus(); }
    }

    /* nro de colunas da grade de arquivos (cards que compartilham o mesmo topo) */
    function gridCols(list) {
        if (list.length < 2) { return 1; }
        var top0 = list[0].offsetTop, c = 1;
        for (var i = 1; i < list.length; i++) {
            if (Math.abs(list[i].offsetTop - top0) < 4) { c++; } else { break; }
        }
        return c;
    }

    function move(dir) {
        var list = items(group);
        if (!list.length) { return; }
        var cur = document.activeElement;
        var idx = list.indexOf(cur);
        if (idx === -1) { list[0].focus(); return; }

        var next = -1;

        if (group === 'files') {                 // ---- grade 2D ----
            var cols = gridCols(list);
            if (dir === 'left')  { next = (idx % cols === 0) ? idx : idx - 1; }
            if (dir === 'right') { next = (idx % cols === cols - 1) ? idx : idx + 1; }
            if (dir === 'down')  { next = idx + cols; }
            if (dir === 'up') {
                if (idx < cols && !UI.el.continueSec.classList.contains('hidden')) {
                    return switchGroup('continue');
                }
                next = idx - cols;
            }
        } else if (group === 'continue') {        // ---- trilho horizontal ----
            if (dir === 'left')  { next = idx - 1; }
            if (dir === 'right') { next = idx + 1; }
            if (dir === 'down')  { return switchGroup('files'); }
        } else if (group === 'settings') {        // ---- lista vertical ----
            if (dir === 'up')   { next = idx - 1; }
            if (dir === 'down') { next = idx + 1; }
        } else {                                  // player / toast
            if (dir === 'left')  { next = idx - 1; }
            if (dir === 'right') { next = idx + 1; }
        }

        if (next >= 0 && next < list.length) {
            list[next].focus();
            list[next].scrollIntoView({
                block: 'nearest',
                inline: (group === 'continue') ? 'center' : 'nearest'
            });
        }
    }

    function switchGroup(g) {
        if (items(g).length) { focusFirst(g); }
    }

    function activate() {
        var cur = document.activeElement;
        if (cur && typeof cur.click === 'function') { cur.click(); }
    }

    function setGroup(g) { group = g; }
    function getGroup()  { return group; }

    return { focusFirst: focusFirst, move: move, activate: activate,
             setGroup: setGroup, getGroup: getGroup };
})();


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

/* --- deteccao de "segurar OK" sobre um card de Continuar assistindo --- */
var holdTimer = null, holdFired = false;

function startHold(elem) {
    holdFired = false;
    holdTimer = setTimeout(function () {
        holdTimer = null;
        holdFired = true;
        ContextMenu.open(elem.dataset.path);
    }, 550);
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

function onKeyDown(ev) {
    var code = ev.keyCode;
    var onPlayer = UI.el.playerScreen.classList.contains('active');
    var ctxOpen  = ContextMenu.isOpen();

    if (code === KEY.GREEN) { DebugLog.toggle(); return; }
    if (code === KEY.BLUE && !onPlayer) { NetUpload.toggleStatus(); return; }

    // ---------------- PAINEL DE AUDIO/LEGENDAS ----------------
    if (onPlayer && UI.settingsOpen()) {
        switch (code) {
            case KEY.UP:    Nav.move('up');   break;
            case KEY.DOWN:  Nav.move('down'); break;
            case KEY.ENTER: Nav.activate();   break;
            case KEY.STOP:
            case KEY.RETURN: UI.closeSettings(); break;
        }
        return;
    }

    // ---------------- PLAYER ----------------
    if (onPlayer) {
        // parar/voltar funciona sempre
        if (code === KEY.STOP || code === KEY.RETURN) { stopAndGoHome(); return; }

        var ctrl = (PlayerHud.mode() === 'controls');

        // botao "Pular abertura" visivel: OK pula direto (mesmo com a HUD escondida),
        // desde que o foco nao esteja nos controles da barra
        if (UI.skipVisible() && !ctrl && code === KEY.ENTER) { UI.doSkip(); return; }

        // 1a tecla quando a HUD esta escondida: so revela (exceto play/pause)
        if (PlayerHud.isFaded() && !UI.skipVisible() &&
            code !== KEY.PLAY && code !== KEY.PAUSE && code !== KEY.PLAYPAUSE) {
            PlayerHud.wake(); return;
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
        return;
    }

    // ---------------- MENU DE CONTEXTO ----------------
    if (ctxOpen) {
        switch (code) {
            case KEY.LEFT:  Nav.move('left');  break;
            case KEY.RIGHT: Nav.move('right'); break;
            case KEY.ENTER: Nav.activate();    break;
            case KEY.STOP:
            case KEY.RETURN: ContextMenu.close(); break;
        }
        return;
    }

    // ---------------- NAVEGACAO (home) ----------------
    switch (code) {
        case KEY.LEFT:  Nav.move('left');  break;
        case KEY.RIGHT: Nav.move('right'); break;
        case KEY.UP:    Nav.move('up');    break;
        case KEY.DOWN:  Nav.move('down');  break;

        case KEY.ENTER:
            var cur = document.activeElement;
            if (cur && cur.classList && cur.classList.contains('is-continue')) {
                if (holdTimer === null && !holdFired) { startHold(cur); }
            } else {
                Nav.activate();
            }
            break;

        case KEY.STOP:
        case KEY.RETURN:
            goUpDirectory();
            break;

        case KEY.RED:
            scanUsb();
            break;
    }
}

function onKeyUp(ev) {
    if ((ev.keyCode === KEY.LEFT || ev.keyCode === KEY.RIGHT) && Scrub.isActive()) {
        Scrub.commit(); return;
    }
    if (ev.keyCode !== KEY.ENTER) { return; }
    if (holdTimer === null && !holdFired) { return; }
    var wasLong = holdFired;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    holdFired = false;
    if (!wasLong) { Nav.activate(); }   // toque curto no card -> Assistir
}

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

    // salva progresso se o app for para segundo plano / fechar
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { Player.saveProgress(); }
    });
    window.addEventListener('beforeunload', function () { Player.saveProgress(); });
    window.addEventListener('blur', function () { Player.saveProgress(); });
    window.addEventListener('pagehide', function () { Player.saveProgress(); });

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

/* Pasta-raiz da biblioteca dentro do HD. Nada fora dela e mostrado. */
var LIBRARY_DIR = 'AmorecoFlix';

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
                ThumbsFolder.load(base);
                SkipData.load(base);
                SubsFolder.load(base);
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
        App.playlist  = entries.filter(function (e) { return !e.isDir; });
        UI.renderFileList(entries);
        Nav.focusFirst('files');

        // titulos/duracao do indice da TV (thumb geralmente vem null, sem problema)
        ContentIndex.refresh(dir, function () {
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
        var rec = ProgressStore.get(entry.file.fullPath);
        openVideo(entry, rec ? rec.position : 0);
    }
}

function goUpDirectory() {
    if (App.dirStack.length) {
        var parent = App.dirStack.pop();
        enterDirectory(parent);
    }
}

/* --- abertura de video --- */

function openVideo(entry, resumeMs) {
    App.playingPath  = entry.file.fullPath;
    App.playingIndex = App.playlist.indexOf(entry);
    App.skip = SkipData.get(entry.name);          // { op:[s,e], ed:[s,e] } ou null
    App.skipDone = {};                             // intervalos ja pulados nesta sessao
    App.extSubs = findExtSubs(entry.name);         // legendas da pasta central /subs
    App.extSub  = App.extSubs[0] ? App.extSubs[0].uri : null;
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
    var inList = App.playlist.filter(function (e) {
        return e.file.fullPath === fullPath;
    })[0];
    if (inList) { openVideo(inList, resumeMs); return; }

    tizen.filesystem.resolve('file://' + fullPath, function (file) {
        var pseudo = { file: file, name: file.name, isDir: false };
        App.playlist = [pseudo];
        openVideo(pseudo, resumeMs);
    }, function (err) {
        UI.toast('Arquivo nao encontrado. O USB foi removido?');
    });
}

function onVideoEnded() {
    var next = findNextEpisode(App.playingPath);
    if (next) {
        UI.showNextToast(next, function () { openVideo(next, 0); });
    } else {
        stopAndGoHome();
    }
}

function playNextEpisode() {
    var next = findNextEpisode(App.playingPath);
    if (next) { Player.stop(); openVideo(next, 0); }
    else { UI.toast('Este e o ultimo episodio da pasta.'); }
}

function stopAndGoHome() {
    Player.stop(true);
    goHome();
}
function goHome() {
    Nav.setGroup('files');
    UI.showHome();
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
        if (document.querySelector('[data-nav-group="continue"] .card')) {
            Nav.setGroup('continue');
            Nav.focusFirst('continue');
        } else {
            Nav.setGroup('files');
            Nav.focusFirst('files');
        }
    }

    function isOpen() { return open_; }

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
function prettyName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ').trim();
}
function baseName(p) { return p.split('/').pop(); }
function dirName(p)  { return p.slice(0, p.lastIndexOf('/')); }
function pad2(n)     { return (n < 10 ? '0' : '') + n; }
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
        try {
            tizen.filesystem.resolve(App.libraryDir.fullPath + '/netupload.json', function (f) {
                f.openStream('r', function (s) {
                    var text = '';
                    try { text = s.read(s.bytesAvailable || 5000); } catch (e) {}
                    s.close();
                    try {
                        var cfg = JSON.parse(text);
                        cb({ pcIp: cfg.pcIp || CFG_DEFAULT.pcIp, port: cfg.port || CFG_DEFAULT.port });
                    } catch (e) { cb(CFG_DEFAULT); }
                }, function () { cb(CFG_DEFAULT); }, 'UTF-8');
            }, function () { cb(CFG_DEFAULT); }, 'r');
        } catch (e) { cb(CFG_DEFAULT); }
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
