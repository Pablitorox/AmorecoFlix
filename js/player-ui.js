/* ============================================================================
 * AmorecoFlix - js/player-ui.js
 * Interface do player (telas 7-12 do prototipo):
 *   HUD (voltar + titulo no topo; barra com marca de creditos e tempo
 *   restante; Play, -10, +10, Episodios, Audio e legendas, Proximo),
 *   avanco acelerado com balao, Pular abertura, card de Proximo episodio,
 *   painel de Audio e legendas, painel de Episodios e "Retomando".
 * A reproducao (AVPlay, retomada, progresso) continua no Player do app.js;
 * aqui fica so o que aparece na tela e as teclas do player.
 *
 * HUD tem 3 modos de foco:
 *   'seek'     foco na barra: esq/dir avancam, OK = play/pausa   (inicial)
 *   'controls' foco nos botoes de baixo (desce da barra)
 *   'top'      foco no botao Voltar (sobe da barra)
 * ==========================================================================*/

var PlayerUI = (function () {

    function $(id) { return document.getElementById(id); }
    var el = {
        screen: $('player-screen'), ui: $('player-ui'),
        crumb: $('now-sub'), title: $('now-playing'), back: $('p-back'),
        bubble: $('p-bubble'), bubbleTime: $('p-bubble-time'), bubbleDelta: $('p-bubble-delta'),
        hintTime: $('p-hint-time'),
        scrub: $('p-scrub'), buf: $('p-buf'), fill: $('progress-fill'), skipped: $('p-skipped'),
        knob: $('p-knob'), credits: $('p-credits'), tCur: $('time-current'), tLeft: $('time-left'),
        btnPlay: $('btn-playpause'), btnRew: $('btn-rewind'), btnFwd: $('btn-forward'),
        btnEps: $('btn-episodes'), btnTracks: $('btn-tracks'), btnNext: $('btn-next'),
        center: $('p-center'), centerSvg: $('p-center-svg'),
        skip: $('skip-btn'), skipLabel: $('skip-label'), skipFill: $('skip-fill'), skipHint: $('skip-hint'),
        next: $('next-card'), nextKicker: document.querySelector('#next-card .next-kicker'),nextImg: $('next-img'), nextNum: $('next-num'), nextTitle: $('next-title'),
        nextSub: $('next-sub'), nextPlay: $('btn-next-play'), nextRing: $('next-ring'),
        nextRingFill: $('next-ring-fill'), nextSecs: $('next-secs'), nextHint: $('next-hint'),
        tracks: $('p-tracks'), setAudio: $('set-audio'), setText: $('set-text'),
        eps: $('p-episodes'), epsRail: $('p-episodes-rail'), epsSeason: $('p-episodes-season'),
        resume: $('p-resume'), resumeKicker: $('p-resume-kicker'), resumeTitle: $('p-resume-title'),
        resumeFill: $('p-resume-fill'), resumeDot: $('p-resume-dot'), resumeNote: $('p-resume-note'),
        resumeStart: $('p-resume-start'), resumeStartLabel: $('p-resume-start-label'),
        resumeRetry: $('p-resume-retry')
    };

    var current = null;       // entry do video aberto
    var curInfo = {};         // { show, season, ep }

    function pctOf(ms, dur) { return dur > 0 ? Math.max(0, Math.min(100, ms / dur * 100)) : 0; }

    /* 4:28 (sem zero a esquerda nos minutos) */
    function fmtShort(sec) {
        sec = Math.round(Math.abs(sec));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
    }

    /* serie / temporada / episodio de um arquivo: pela biblioteca (numeracao
       e titulos do TMDB) e, sem ela, pelo nome do arquivo e da pasta */
    function infoOf(entry) {
        var path = entry.file.fullPath, t = window.Library ? Library.ofPath(path) : null;
        var le = t ? Library.episodes(t).filter(function (e) { return e.path === path; })[0] : null;
        if (t && le) {
            var series = t.kind === 'serie' || t.kind === 'anime';
            return { t: t, le: le, show: t.kind === 'filme' ? '' : Library.displayName(t),
                     season: series ? (le.s || 0) : 0, ep: series && le.e != null ? le.e : null };
        }
        var i = UI.epInfo(entry.name) || {};
        return {
            show:   UI.seriesNameFromPath(path),
            season: i.s || seasonNumber(baseName(dirName(path))) || 0,
            ep:     i.e != null ? i.e : null
        };
    }
    /* nome do episodio/filme sem o numero (cards: o numero ja aparece grande) */
    function epTitle(entry, info) {
        info = info || infoOf(entry);
        if (info.t && info.le) { return Library.epTitle(info.t, info.le); }
        return info.ep != null ? 'Episódio ' + info.ep : UI.cleanName(entry.name);
    }
    /* titulo grande do player: "E7 · Alcohol Poison" / "Episódio 7" / filme */
    function headTitle(entry, info) {
        var name = epTitle(entry, info);
        if (info.ep == null) { return name; }
        return /^Episódio \d+$/.test(name) ? name : 'E' + info.ep + ' · ' + name;
    }
    /* "Death Parade · T1 E7" */
    function shortLabel(info, entry) {
        var name = info.show || UI.cleanName(entry.name);
        if (info.ep == null) { return name; }
        return name + ' · ' + (info.season ? 'T' + info.season + ' ' : '') + 'E' + info.ep;
    }
    /* duracao conhecida de um arquivo (progresso ou cache de miniaturas) */
    function durationOf(entry) {
        var rec = ProgressStore.get(entry.file.fullPath), th = Thumbs.get(entry.file.fullPath);
        var d = (rec && rec.duration) || (th && th.d) || 0;
        return (d > 0 && d < 4294967000) ? d : 0;
    }
    function minutes(ms) { return ms ? Math.max(1, Math.round(ms / 60000)) + ' min' : ''; }


    /* ======================= abrir um video ======================= */

    function show(entry) {
        current = entry;
        curInfo = infoOf(entry);
        if (curInfo.ep != null) {
            el.crumb.textContent = (curInfo.show || UI.cleanName(entry.name)) +
                                   (curInfo.season ? ' · Temporada ' + curInfo.season : '');
        } else {
            var m = curInfo.t ? Meta.title(curInfo.t.key) : null;
            var y = (m && m.ano) || ((/\b(19|20)\d{2}\b/.exec(entry.name) || [])[0]);
            el.crumb.textContent = curInfo.show || ('Filme' + (y ? ' · ' + y : ''));
        }
        el.title.textContent = headTitle(entry, curInfo);
        reset();
        // filme solto: a playlist e a pasta Filmes inteira, nao uma lista de episodios
        el.btnEps.hidden = isLooseFilm(entry.file.fullPath) || !(App.playlist && App.playlist.length > 1);
        // filme de colecao: o "proximo" e o proximo filme dela
        var film = isFilmPath(entry.file.fullPath);
        pill(el.btnNext, 'next', film ? 'Próximo filme' : 'Próximo episódio', true);
        el.nextKicker.textContent = film ? 'PRÓXIMO FILME' : 'PRÓXIMO EPISÓDIO';
        el.next.setAttribute('aria-label', film ? 'Próximo filme' : 'Próximo episódio');
        refreshNextBtn();
        Screens.go('player');
        resetHud();
    }

    /* tudo de volta ao estado inicial (novo video / player parado) */
    function reset() {
        Scrub.cancel();
        hideNext();
        resetCredits();
        hideSkip();
        closeTracks(true);
        closeEpisodes(true);
        hideResume();
        lastDur = -1;
        el.credits.hidden = true;
        el.buf.style.width = '0%';
        el.center.hidden = true;
        el.center.classList.remove('flash', 'stay');
        setPlayLabel(false);
    }


    /* ======================= HUD ======================= */

    var mode = 'seek', fadeTimer = null;

    function setMode(m) {
        mode = m;
        el.ui.classList.remove('mode-seek', 'mode-controls', 'mode-top');
        el.ui.classList.add('mode-' + m);
    }
    function fade(on) { el.ui.classList.toggle('faded', !!on); }
    function isFaded() { return el.ui.classList.contains('faded'); }
    function blurFocus() {
        var a = document.activeElement;
        if (a && a !== document.body && a.blur) { a.blur(); }
    }

    /* mostra a HUD; tocando, some sozinha (4 s na barra, 6 s nos botoes) e
       volta para o modo barra. Pausado, fica. */
    function wake() {
        fade(false);
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        if (Player.isPaused() || Scrub.isActive() || panelOpen()) { return; }
        fadeTimer = setTimeout(function () {
            fadeTimer = null;
            if (Player.isPaused() || Scrub.isActive() || panelOpen()) { return; }
            fade(true);
            if (mode !== 'seek') { setMode('seek'); blurFocus(); }
        }, mode === 'seek' ? 4000 : 6000);
    }
    function toControls() { setMode('controls'); Nav.focusFirst('player'); wake(); }
    function toSeek()     { setMode('seek'); blurFocus(); wake(); }
    function toTop()      { setMode('top'); Nav.setGroup('p-top'); el.back.focus(); wake(); }
    function resetHud()   { setMode('seek'); blurFocus(); wake(); }

    function setPlayLabel(paused) {
        el.btnPlay.innerHTML = Icons.svg(paused ? 'play' : 'pause', 40);
        el.btnPlay.setAttribute('aria-label', paused ? 'Reproduzir' : 'Pausar');
    }
    function pulseCenter(paused) {
        el.center.classList.remove('flash', 'stay');
        el.centerSvg.innerHTML = Icons.paths(paused ? 'play' : 'pause');
        el.center.hidden = false;
        void el.center.offsetWidth;            // reinicia a animacao
        // pausado: icone de play fica na tela; voltando: flash rapido e some
        el.center.classList.add(paused ? 'stay' : 'flash');
    }

    /* play/pausa pelo controle; quiet = sem o icone no centro (paineis) */
    function togglePlay(quiet) {
        var paused = Player.togglePlay();
        setPlayLabel(paused);
        if (!quiet) { pulseCenter(paused); }
        else if (!paused) { el.center.hidden = true; el.center.classList.remove('stay'); }
        wake();
        return paused;
    }


    /* ======================= barra ======================= */

    var lastDur = -1;

    function updateProgress(pos, dur) {
        if (dur !== lastDur) { lastDur = dur; placeCredits(dur); }
        el.tLeft.textContent = dur > 0 ? '−' + fmtTime(Math.max(0, dur - pos)) : '';
        refreshNextBtn();
        if (Scrub.isActive()) { return; }      // o balao do avanco manda na barra
        var pct = pctOf(pos, dur);
        el.fill.style.width = pct + '%';
        el.knob.style.left = pct + '%';
        el.tCur.textContent = fmtTime(pos);
    }
    function setBuffered(pct) { el.buf.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

    /* marca de "creditos": so com dado real do skip.json (ed = encerramento
       de anime, cr = creditos detectados no PC). Sem dado, nao mostra. */
    function creditsMarkSec(durSec) {
        var s = App.skip;
        if (s && s.ed && s.ed[0] > durSec * 0.5 && s.ed[0] < durSec - 5) { return s.ed[0]; }
        if (s && s.cr && s.cr[0] > durSec * 0.5 && s.cr[0] < durSec - 5) { return s.cr[0]; }
        return 0;
    }
    function placeCredits(durMs) {
        var at = durMs > 0 ? creditsMarkSec(durMs / 1000) : 0;
        el.credits.hidden = !at;
        if (at) { el.credits.style.left = pctOf(at * 1000, durMs) + '%'; }
    }

    function refreshNextBtn() {
        var hide = !App.nextEp;
        if (el.btnNext.hidden !== hide) { el.btnNext.hidden = hide; }
    }


    /* ======================= avanco (segurar esq/dir) ======================= */

    var Scrub = (function () {
        var active = false, sec = 0, start = 0, presses = 0, tAuto = null;

        function step(dir) {
            if (!active) {
                active = true; presses = 0;
                start = sec = Player.getPosition() / 1000;
                el.ui.classList.add('scrubbing');
            }
            presses++;
            var d = presses < 4 ? 10 : (presses < 9 ? 30 : 60);
            var dur = Player.getDuration() / 1000;
            sec = Math.max(0, Math.min(dur - 2, sec + dir * d));
            draw(dur);
            wake();
            clearTimeout(tAuto);
            tAuto = setTimeout(commit, 900);        // se o keyup nao vier
        }

        function draw(dur) {
            var p = pctOf(sec, dur), p0 = pctOf(start, dur);
            el.fill.style.width = Math.min(p, p0) + '%';
            el.skipped.style.left = Math.min(p, p0) + '%';
            el.skipped.style.width = Math.abs(p - p0) + '%';
            el.knob.style.left = p + '%';
            el.bubbleTime.textContent = fmtTime(sec * 1000);
            el.bubbleDelta.textContent = (sec >= start ? '+' : '−') + fmtShort(sec - start);
            el.hintTime.textContent = fmtTime(sec * 1000);
            el.bubble.hidden = false;
            // balao centrado no marcador, sem sair da tela
            var w = el.scrub.offsetWidth, bw = el.bubble.offsetWidth;
            var x = p / 100 * w;
            x = Math.max(bw / 2 - 100, Math.min(w + 110 - bw / 2, x));
            el.bubble.style.left = x + 'px';
        }

        function clear() {
            active = false;
            clearTimeout(tAuto);
            el.ui.classList.remove('scrubbing');
            el.bubble.hidden = true;
            el.skipped.style.width = '0';
        }
        function commit() {
            if (!active) { return; }
            clear();
            Player.seekTo(Math.round(sec * 1000));
            updateProgress(Player.getPosition(), Player.getDuration());
            wake();
        }
        function cancel() { if (active) { clear(); } }

        return { step: step, commit: commit, cancel: cancel, isActive: function () { return active; } };
    })();


    /* ======================= pular abertura / encerramento ======================= */

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
        if (!seg) { if (skipShown) { hideSkip(); } return; }

        var target = Math.min(seg[1], dur - 3);       // nunca pula pros ultimos 3 s
        if (target <= sec + 1) { hideSkip(); return; }
        if (!skipShown || skipTarget !== Math.round(target)) {
            el.skipLabel.textContent = key === 'op' ? 'Pular abertura' : 'Pular encerramento';
            el.skipHint.textContent = 'some sozinho quando ' + (key === 'op' ? 'a abertura' : 'o encerramento') + ' acabar';
            el.skip.dataset.key = key;
            skipTarget = Math.round(target);
            el.skip.hidden = false;
            el.skipHint.hidden = false;
            skipShown = true;
        }
        el.skipFill.style.width = pctOf(sec - seg[0], seg[1] - seg[0]) + '%';
    }
    function hideSkip() {
        if (!skipShown) { return; }
        skipShown = false;
        el.skip.hidden = true;
        el.skipHint.hidden = true;
    }
    function doSkip() {
        if (!skipShown) { return false; }
        App.skipDone[el.skip.dataset.key || 'op'] = true;
        Player.seekTo(skipTarget * 1000);
        hideSkip();
        wake();
        return true;
    }
    function skipVisible() { return skipShown; }


    /* ======================= proximo episodio ======================= */
    /* Momento do card: 1) fim do encerramento (ed) de anime, 2) cr[0] detectado
     * por detectar-creditos.ps1, 3) padrao: 45 s antes do fim. Nos creditos o
     * card espera OK (assistir) ou ▲ (ocultar); no FIM do video conta 5 s. */

    var creditsShown = false, creditsDismissed = false;
    var nextMode = null, nextCb = null, nextTimer = null;
    var AUTOPLAY_SECS = 5, RING_C = 2 * Math.PI * 17;

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
            if (creditsShown) { hideNext(); }
            return;
        }
        if (creditsShown || creditsDismissed || sec < at || sec >= durMs / 1000 - 0.5) { return; }
        creditsShown = true;
        hideSkip();
        showNext(App.nextEp, function () { playNextEpisode(true); }, 'credits');
    }
    function creditsVisible() { return creditsShown; }
    function dismissCredits() { creditsDismissed = true; hideNext(); }
    function resetCredits() { creditsShown = false; creditsDismissed = false; }

    /* kind: 'credits' (espera OK) ou 'end' (fim do video: conta 5 s) */
    function showNext(entry, onPlay, kind) {
        clearInterval(nextTimer); nextTimer = null;
        nextMode = kind;
        nextCb = onPlay;
        var info = infoOf(entry), dur = durationOf(entry);
        el.nextNum.textContent = info.ep != null ? pad2(info.ep) : '';
        el.nextTitle.textContent = epTitle(entry, info);
        el.nextSub.textContent = (dur ? minutes(dur) + ' · ' : '') + 'pronto para tocar';
        el.nextImg.parentNode.style.background = toneOf(info.show || entry.name);
        Art.set(el.nextImg, ThumbsFolder.get(entry.name), true);
        el.next.hidden = false;

        if (kind === 'credits') {
            el.nextRing.hidden = true;
            el.nextHint.textContent = 'OK assiste · ▲ oculta · no fim, começa sozinho';
            return;
        }
        var left = AUTOPLAY_SECS;
        el.nextRing.hidden = false;
        el.nextSecs.textContent = left;
        el.nextRingFill.style.transition = 'none';
        el.nextRingFill.style.strokeDashoffset = '0';
        el.nextRingFill.getBoundingClientRect();              // aplica antes de animar
        el.nextRingFill.style.transition = 'stroke-dashoffset 1s linear';
        el.nextHint.textContent = 'Começa sozinho · RETURN para sair';
        nextTimer = setInterval(function () {
            left--;
            if (left <= 0) { playNext(); return; }
            el.nextSecs.textContent = left;
            el.nextRingFill.style.strokeDashoffset = String(RING_C * (AUTOPLAY_SECS - left) / AUTOPLAY_SECS);
        }, 1000);
    }
    function playNext() {
        var cb = nextCb;
        hideNext();
        if (cb) { cb(); }
    }
    function hideNext() {
        clearInterval(nextTimer); nextTimer = null;
        nextMode = null;
        nextCb = null;
        creditsShown = false;
        el.next.hidden = true;
    }


    /* ======================= paineis (pausam o video - D1) ======================= */

    var wasPlaying = false;
    function panelOpen() { return !el.tracks.hidden || !el.eps.hidden; }
    function pauseForPanel() {
        wasPlaying = !Player.isPaused();
        if (wasPlaying) { togglePlay(true); }
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        el.screen.classList.add('panel-open');
    }
    function resumeAfterPanel(silent) {
        el.screen.classList.remove('panel-open');
        var play = wasPlaying && !silent;
        wasPlaying = false;
        if (play && Player.isPaused()) { togglePlay(true); }
    }


    /* ---------- audio e legendas ---------- */

    function trackRow(label, sub, on, onclick) {
        var d = h('div', 'p-track-row focusable' + (on ? ' on' : ''));
        d.tabIndex = 0;
        d.innerHTML = '<span class="p-track-check">' + (on ? Icons.svg('check', 24, 2.6) : '') + '</span>' +
                      '<span class="p-track-text"><b>' + escapeHtml(label) + '</b>' +
                      (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</span>';
        d.addEventListener('click', onclick);
        return d;
    }

    /* "Dublado" / "Original": pelo rotulo da faixa ou, com 2+ audios, PT = dublado */
    function audioSub(t, all) {
        if (/dub/i.test(t.label)) { return 'Dublado'; }
        if (/orig/i.test(t.label)) { return 'Original'; }
        if (all.length > 1) {
            var isPt = (t.lang || '').slice(0, 2) === 'po' || (t.lang || '').slice(0, 2) === 'pt';
            var hasPt = all.some(function (a) { var l = (a.lang || '').slice(0, 2); return l === 'po' || l === 'pt'; });
            var hasOther = all.some(function (a) { var l = (a.lang || '').slice(0, 2); return l && l !== 'po' && l !== 'pt'; });
            if (isPt && hasOther) { return 'Dublado'; }
            if (!isPt && hasPt) { return 'Original'; }
        }
        return t.label && !/^(und|default)$/i.test(t.label) ? t.label : '';
    }

    function buildTracks() {
        var a = el.setAudio, s = el.setText;
        a.innerHTML = ''; s.innerHTML = '';
        function pick(fn) {
            return function () {
                var idx = Nav.items('tracks').indexOf(document.activeElement);
                fn();
                buildTracks();
                Nav.focusIndex('tracks', idx);
            };
        }

        var audio = App.tracks.audio;
        if (audio.length <= 1) {
            a.appendChild(trackRow(audio[0] ? langName(audio[0].lang, 'Original') : 'Original', '', true, function () {}));
        } else {
            audio.forEach(function (t, i) {
                a.appendChild(trackRow(langName(t.lang, 'Faixa ' + (i + 1)), audioSub(t, audio),
                    t.index === App.trackSel.audio, pick(function () { Player.selectAudio(t.index); })));
            });
        }

        s.appendChild(trackRow('Desligadas', '', App.trackSel.text === -1, pick(function () { Player.selectText(-1); })));
        App.tracks.text.forEach(function (t, i) {
            var name = langName(t.lang, 'Legenda ' + (i + 1));
            s.appendChild(trackRow(t.forced ? name + ' — só falas estrangeiras' : name,
                t.forced ? 'Forçada · traduz só as falas em outro idioma' : (t.label && !t.forced ? t.label : ''),
                t.index === App.trackSel.text, pick(function () { Player.selectText(t.index); })));
        });
        (App.extSubs || []).forEach(function (xs, i) {
            var name = xs.lang ? langName(xs.lang, xs.lang) : (App.extSubs.length === 1 ? 'Legenda do arquivo' : 'Arquivo ' + (i + 1));
            var ext = (/\.([a-z0-9]+)$/i.exec(xs.name || '') || [0, 'srt'])[1].toLowerCase();
            s.appendChild(trackRow(xs.forced ? name + ' — só falas estrangeiras' : name,
                'Arquivo .' + ext + (xs.forced ? ' · forçada' : ''),
                App.trackSel.text === (-2 - i), pick(function () { Player.selectText(-2 - i); })));
        });
    }

    function openTracks() {
        if (Player.isResuming() || !el.tracks.hidden) { return; }
        closeEpisodes(true);
        buildTracks();
        el.tracks.hidden = false;
        Layers.open('tracks');
        pauseForPanel();
        wake();                                  // titulo fica; a base da HUD sai (.panel-open)
        // foco na legenda escolhida (o que mais se troca)
        var list = Nav.items('tracks'), on = el.setText.querySelector('.on');
        Nav.focusIndex('tracks', on ? list.indexOf(on) : 0);
    }
    /* silent = so esconde (troca de video / player parando), sem voltar a tocar */
    function closeTracks(silent) {
        if (el.tracks.hidden) { return; }
        el.tracks.hidden = true;
        Layers.close('tracks', true);
        resumeAfterPanel(silent);
        if (!silent) { resetHud(); }
    }


    /* ---------- episodios ---------- */

    function epCard(entry) {
        var info = infoOf(entry), rec = ProgressStore.get(entry.file.fullPath);
        var dur = (rec && rec.duration) || durationOf(entry);
        var isCur = entry.file.fullPath === App.playingPath;
        var done = !!(rec && rec.done), pct = 0, sub;
        if (isCur) { sub = 'Assistindo agora'; pct = pctOf(Player.getPosition(), Player.getDuration()); }
        else if (done) { sub = (dur ? minutes(dur) + ' · ' : '') + 'Assistido'; pct = 100; }
        else if (rec && rec.position > 3000 && dur) {
            sub = 'Parou em ' + fmtTime(rec.position) + ' · ' + minutes(dur - rec.position) + ' restantes';
            pct = pctOf(rec.position, dur);
        } else { sub = minutes(dur); }

        var c = h('div', 'ep-card focusable' + (isCur ? ' is-current' : '') + (done ? ' is-done' : ''));
        c.tabIndex = 0;
        c.innerHTML =
            '<div class="ep-art" style="background:' + toneOf(info.show || entry.name) + '">' +
                '<img class="art-img" alt="">' +
                '<span class="ep-num">' + (info.ep != null ? pad2(info.ep) : '') + '</span>' +
                (done ? '<span class="ep-check">' + Icons.svg('check', 20, 3) + '</span>' : '') +
                '<div class="ep-bar"><i style="width:' + pct + '%"></i></div>' +
            '</div>' +
            '<span class="ep-title">' + escapeHtml(epTitle(entry, info)) + '</span>' +
            '<span class="ep-sub">' + escapeHtml(sub) + '</span>';
        Art.set(c.querySelector('img'), ThumbsFolder.get(entry.name));
        c.addEventListener('click', function () {
            if (entry.file.fullPath === App.playingPath) { closeEpisodes(); return; }
            closeEpisodes(true);
            Player.stop();
            openVideo(entry, savedPosition(entry));
        });
        return c;
    }

    function openEpisodes() {
        var list = App.playlist || [];
        if (Player.isResuming() || list.length < 2 || !el.eps.hidden) { return; }
        closeTracks(true);
        el.epsRail.innerHTML = '';
        el.epsRail.style.transform = '';
        var curIdx = 0;
        list.forEach(function (e, i) {
            if (e.file.fullPath === App.playingPath) { curIdx = i; }
            el.epsRail.appendChild(epCard(e));
        });
        el.epsSeason.textContent = curInfo.season ? '· Temporada ' + curInfo.season : '';
        el.eps.hidden = false;
        Layers.open('episodes');
        pauseForPanel();
        wake();                                  // titulo fica; a base da HUD sai (.panel-open)
        Nav.focusIndex('episodes', curIdx);
    }
    function closeEpisodes(silent) {
        if (el.eps.hidden) { return; }
        el.eps.hidden = true;
        Art.release(el.epsRail);
        Layers.close('episodes', true);
        resumeAfterPanel(silent);
        if (!silent) { resetHud(); }
    }


    /* ======================= Retomando ======================= */
    /* Player.onResume avisa: 'start' (aparece se demorar > 800 ms), 'retry'
     * (outra tentativa: aparece na hora), 'ok' (some) e 'gaveup' (desistiu:
     * pergunta e, sem escolha em 5 s, comeca do inicio - decisao D4). */

    var rs = { timer: null, countdown: null, gaveup: false };

    function onResume(ev) {
        if (ev.state === 'start') {
            clearTimeout(rs.timer);
            rs.timer = setTimeout(function () { showResume(ev); }, 800);
        } else if (ev.state === 'retry') {
            showResume(ev);
        } else if (ev.state === 'ok') {
            hideResume();
        } else if (ev.state === 'gaveup') {
            showGaveUp(ev);
        }
    }

    function fillResume(ev, title, note) {
        el.resumeKicker.textContent = current ? shortLabel(curInfo, current) : '';
        el.resumeTitle.textContent = title;
        el.resumeNote.textContent = note;
        var p = pctOf(ev.target, Player.getDuration());
        el.resumeFill.style.width = p + '%';
        el.resumeDot.style.left = p + '%';
    }

    function openResume() {
        if (el.resume.hidden) {
            closeTracks(true);
            closeEpisodes(true);
            el.resume.hidden = false;
            document.body.classList.add('resuming');
            Layers.open('resume');
            fade(true);
        }
        Nav.focusFirst('resume');
    }

    function showResume(ev) {
        clearTimeout(rs.timer); rs.timer = null;
        rs.gaveup = false;
        el.resume.classList.remove('gaveup');
        el.resumeRetry.hidden = true;
        el.resumeStartLabel.textContent = 'Começar do início';
        if (ev.dir > 0) {
            fillResume(ev, 'Recuperando a reprodução', 'Pulando um trecho com problema do arquivo (' + ev.step + ' de ' + ev.total + ')…');
        } else {
            fillResume(ev, 'Voltando para ' + fmtTime(ev.target),
                ev.state === 'retry' ? 'Tentando de outro jeito (' + ev.step + ' de ' + ev.total + ')…'
                                     : 'Seu ponto fica salvo mesmo se demorar.');
        }
        openResume();
    }

    function showGaveUp(ev) {
        clearTimeout(rs.timer); rs.timer = null;
        clearInterval(rs.countdown);
        rs.gaveup = true;
        el.resume.classList.add('gaveup');
        el.resumeRetry.hidden = false;
        fillResume(ev, 'Não consegui voltar para ' + fmtTime(ev.target),
                   'O ponto continua salvo. Sem escolha, começa do início sozinho.');
        var left = 5;
        el.resumeStartLabel.textContent = 'Começar do início (' + left + ')';
        rs.countdown = setInterval(function () {
            left--;
            if (left <= 0) { chooseStart(); return; }
            el.resumeStartLabel.textContent = 'Começar do início (' + left + ')';
        }, 1000);
        openResume();
    }
    function stopCountdown() {
        if (!rs.countdown) { return; }
        clearInterval(rs.countdown); rs.countdown = null;
        el.resumeStartLabel.textContent = 'Começar do início';
    }

    function hideResume() {
        clearTimeout(rs.timer); rs.timer = null;
        clearInterval(rs.countdown); rs.countdown = null;
        if (el.resume.hidden) { return; }
        el.resume.hidden = true;
        document.body.classList.remove('resuming');
        Layers.close('resume', true);
        if (isPlayerActive()) { resetHud(); }
    }

    /* desistiu: mantem o ponto salvo; escolha durante a retomada: o usuario
       quer o comeco de verdade, o progresso passa a seguir o novo ponto */
    function chooseStart() {
        var keep = rs.gaveup;
        hideResume();
        Player.restart(keep);
        UI.toast('Começando do início' + (keep ? ' - o ponto continua salvo.' : '.'));
    }
    function chooseRetry() {
        hideResume();
        Player.retryResume();
    }


    /* ======================= teclas ======================= */

    function isPlayKey(code) { return code === KEY.PLAY || code === KEY.PAUSE || code === KEY.PLAYPAUSE; }

    function keys(code) {
        Player.poke();                       // retomada presa sem eventos/timers: a tecla destrava

        // fim do video com o card de proximo: OK assiste, RETURN sai
        if (nextMode === 'end') {
            if (code === KEY.ENTER) { playNext(); }
            else if (code === KEY.RETURN || code === KEY.STOP) { stopAndGoHome(); }
            return true;
        }
        if (code === KEY.STOP || code === KEY.RETURN) { Scrub.cancel(); stopAndGoHome(); return true; }

        // "Pular abertura" na tela: OK pula (mesmo com a HUD escondida), fora dos botoes
        if (skipShown && mode === 'seek' && code === KEY.ENTER) { doSkip(); return true; }

        // card "Proximo episodio" nos creditos: OK assiste, ▲ oculta
        if (creditsShown && mode === 'seek') {
            if (code === KEY.ENTER) { playNextEpisode(true); return true; }
            if (code === KEY.UP)    { dismissCredits(); return true; }
        }

        // 1a tecla com a HUD escondida: so revela (exceto play/pausa)
        if (isFaded() && !isPlayKey(code) && code !== KEY.YELLOW) { wake(); return true; }
        wake();

        switch (code) {
            case KEY.YELLOW: openTracks(); break;
            case KEY.LEFT:
            case KEY.RIGHT:
                var dir = code === KEY.LEFT ? -1 : 1;
                if (mode === 'seek') { Scrub.step(dir); }
                else if (mode === 'controls') { Nav.move(dir < 0 ? 'left' : 'right'); }
                break;
            case KEY.DOWN:
                if (mode === 'top') { toSeek(); }
                else if (mode === 'seek') { toControls(); }
                break;
            case KEY.UP:
                if (mode === 'controls') { toSeek(); }
                else if (mode === 'seek') { toTop(); }
                break;
            case KEY.ENTER:
                if (mode === 'seek') { togglePlay(); } else { Nav.activate(); }
                break;
            case KEY.PLAY:
            case KEY.PAUSE:
            case KEY.PLAYPAUSE: togglePlay(); break;
            case KEY.FF:  Player.seekBy(85000);  break;
            case KEY.REW: Player.seekBy(-85000); break;
        }
        return true;
    }

    function keyUp(code) {
        if ((code === KEY.LEFT || code === KEY.RIGHT) && Scrub.isActive()) { Scrub.commit(); }
    }


    /* ======================= montagem ======================= */

    function pill(btn, icon, label, iconAfter) {
        btn.innerHTML = iconAfter ? label + Icons.svg(icon, 24) : Icons.svg(icon, 24) + label;
    }

    function init() {
        el.back.innerHTML = Icons.svg('back', 28);
        el.btnRew.innerHTML = Icons.svg('rew10', 36, 1.8);
        el.btnFwd.innerHTML = Icons.svg('fwd10', 36, 1.8);
        pill(el.btnEps, 'episodes', 'Episódios');
        pill(el.btnTracks, 'tracks', 'Áudio e legendas');
        $('skip-ic').innerHTML = Icons.svg('skip', 30);
        $('next-play-ic').innerHTML = Icons.svg('play', 26);
        $('p-resume-start-ic').innerHTML = Icons.svg('restart', 26);
        el.scrub.appendChild(el.bubble);          // balao posicionado em relacao a barra
        setPlayLabel(false);

        el.btnPlay.onclick   = function () { togglePlay(); };
        el.btnRew.onclick    = function () { Player.seekBy(-10000); wake(); };
        el.btnFwd.onclick    = function () { Player.seekBy(10000); wake(); };
        el.btnEps.onclick    = openEpisodes;
        el.btnTracks.onclick = openTracks;
        el.btnNext.onclick   = function () { playNextEpisode(); };
        el.back.onclick      = stopAndGoHome;
        el.skip.onclick      = doSkip;
        el.nextPlay.onclick  = playNext;
        el.resumeStart.onclick = chooseStart;
        el.resumeRetry.onclick = chooseRetry;

        // ao terminar o flash de "voltando", esconde; pausado (stay), mantem
        el.center.addEventListener('animationend', function () {
            if (!el.center.classList.contains('stay')) {
                el.center.hidden = true;
                el.center.classList.remove('flash');
            }
        });

        Player.setResumeListener(onResume);
    }

    Nav.define('player',   { type: 'row' });
    Nav.define('tracks',   { type: 'col' });
    Nav.define('episodes', { type: 'rail', scroll: railScroller(el.epsRail) });
    Nav.define('resume',   { type: 'row' });

    Screens.register('player', { el: el.screen, onKey: keys });

    Layers.register('tracks', { onKey: function (code) {
        switch (code) {
            case KEY.UP:    Nav.move('up');   break;
            case KEY.DOWN:  Nav.move('down'); break;
            case KEY.ENTER: Nav.activate();   break;
            case KEY.YELLOW:
            case KEY.STOP:
            case KEY.RETURN: closeTracks(); break;
        }
    } });
    Layers.register('episodes', { onKey: function (code) {
        switch (code) {
            case KEY.LEFT:  Nav.move('left');  break;
            case KEY.RIGHT: Nav.move('right'); break;
            case KEY.ENTER: Nav.activate();    break;
            case KEY.STOP:
            case KEY.RETURN: closeEpisodes(); break;
        }
    } });
    Layers.register('resume', { onKey: function (code) {
        Player.poke();
        switch (code) {
            case KEY.LEFT:  stopCountdown(); Nav.move('left');  break;
            case KEY.RIGHT: stopCountdown(); Nav.move('right'); break;
            case KEY.ENTER: Nav.activate(); break;
            case KEY.STOP:
            case KEY.RETURN: hideResume(); stopAndGoHome(); break;
        }
    } });

    return {
        init: init, show: show, reset: reset, keyUp: keyUp,
        updateProgress: updateProgress, setBuffered: setBuffered, setPlayLabel: setPlayLabel,
        updateSkip: updateSkip, hideSkip: hideSkip,
        updateCredits: updateCredits, showNext: showNext, hideNext: hideNext,
        buildTracks: buildTracks, closePanels: function () { closeTracks(true); closeEpisodes(true); },
        scrubbing: function () { return Scrub.isActive(); }
    };
})();
