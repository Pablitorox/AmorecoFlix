/* TV falsa p/ testar o app no navegador: tizen.filesystem em memoria + AVPlay simulado.
 * Cenario via ?s=<nome>. Resultado em window.T (eventos) para leitura externa. */
(function () {
    var q = {}; location.search.replace(/[?&]([^=]+)=([^&]*)/g, function (_, k, v) { q[k] = decodeURIComponent(v); });
    var S = q.s || 'ok';
    // ?tv=h1 : play() com o seek em andamento congela (hipotese principal, bate com o log da TV)
    // ?tv=h2 : qualquer seek no estado READY congela ao dar play
    // ?tv=h3 : qualquer seek com o video tocando congela
    var TV = q.tv || '';
    var T = window.T = { scenario: S, events: [], seeks: [], toasts: [] };
    // timers originais: o mock continua funcionando mesmo com ?timers=dead
    var _st = window.setTimeout.bind(window), _si = window.setInterval.bind(window), _ci = window.clearInterval.bind(window);
    window._st = _st; window._si = _si;
    // ?timers=dead: depois do play(), timers do APP (inclusive os ja agendados) param de disparar
    if (q.timers === 'dead') {
        window.setTimeout = function (fn, ms) { return _st(function () { if (!window.__timersDead) { fn(); } }, ms); };
        window.setInterval = function (fn, ms) { return _si(function () { if (!window.__timersDead) { fn(); } }, ms); };
    }
    function killTimers() {
        if (q.timers !== 'dead' || window.__timersDead) { return; }
        window.__timersDead = true;
        ev('TIMERS DO APP PARADOS');
    }
    function ev(m) { T.events.push(((performance.now() / 1000).toFixed(1)) + 's ' + m); }

    // NetUpload: sem PC no simulador - a conexao falha em silencio (sem erro no console)
    window.WebSocket = function () {
        var self = this;
        self.readyState = 3;
        _st(function () { if (self.onerror) { self.onerror({}); } if (self.onclose) { self.onclose({}); } }, 50);
    };
    window.WebSocket.prototype.send = function () {};
    window.WebSocket.prototype.close = function () {};

    // tecla do controle pelo console: key(10009) = RETURN, key(13, 600) = segurar OK 600 ms
    window.key = function (code, holdMs) {
        function fire(type) {
            var e = new KeyboardEvent(type, { bubbles: true });
            Object.defineProperty(e, 'keyCode', { get: function () { return code; } });
            document.dispatchEvent(e);
        }
        fire('keydown');
        if (!holdMs) { fire('keyup'); return; }
        var t0 = performance.now(), iv = _si(function () {
            if (performance.now() - t0 >= holdMs) { clearInterval(iv); fire('keyup'); } else { fire('keydown'); }
        }, 50);
    };

    /* ---------- HD ----------
     * padrao : HD falso em memoria (serie "Show", p/ testes de retomada)
     * ?hd=real: le o HD de verdade pelo serve.js (/hd/...), SOMENTE LEITURA -
     *           o que o app grava (progresso, log) fica em FS.files (memoria)
     * ?hd=0  : nenhum HD conectado */
    var REAL = q.hd === 'real', NOHD = q.hd === '0';
    var ROOT = q.mount ? '/opt/media/USBDrive' + q.mount : '/opt/media/USBDriveC1';               // montagem ATUAL (diferente das chaves salvas)
    var LIB = ROOT + '/AmorecoFlix';
    var SEASON = LIB + '/Series/Show/Show - 1ª Temporada';
    var FS = window.FS = { files: {}, dirs: {}, sizes: {} };
    var now = Date.now();
    if (REAL) {
        [ROOT, LIB].forEach(function (d) { FS.dirs[d] = true; });
        try { localStorage.clear(); } catch (e) {}
    } else {
        [ROOT, LIB, LIB + '/Series', LIB + '/Series/Show', SEASON, LIB + '/thumbs', LIB + '/subs'].forEach(function (d) { FS.dirs[d] = true; });
        ['04', '05', '06'].forEach(function (n) {
            var p = SEASON + '/Show S01E' + n + '.mkv'; FS.files[p] = ''; FS.sizes[p] = 900 * 1024 * 1024;
        });
        var K5 = 'Series/Show/Show - 1ª Temporada/Show S01E05.mkv';
        var K6 = 'Series/Show/Show - 1ª Temporada/Show S01E06.mkv';
        // HD: formato ANTIGO (caminho completo, outra montagem), E05 em 20:00 (mais antigo) e E06 em 10:00
        var disk = {};
        disk['/opt/media/USBDriveB1/AmorecoFlix/' + K5] = { path: '/opt/media/USBDriveB1/AmorecoFlix/' + K5, name: 'Show S01E05.mkv', position: 1200000, duration: 2400000, done: false, updated: now - 60000 };
        disk['/opt/media/USBDriveB1/AmorecoFlix/' + K6] = { path: 'x', name: 'Show S01E06.mkv', position: 600000, duration: 2400000, done: false, updated: now - 900000 };
        FS.files[LIB + '/progresso.json'] = JSON.stringify(disk);
        // localStorage: formato antigo, montagem A1, E05 em 25:00 (mais NOVO que o HD)
        var local = {};
        local['/opt/media/USBDriveA1/AmorecoFlix/' + K5] = { path: 'y', name: 'Show S01E05.mkv', position: q.pos ? (+q.pos * 1000) : 1500000, duration: 2400000, done: false, updated: now - 1000 };
        try { localStorage.clear(); localStorage.setItem('meuplayer.progress.v1', JSON.stringify(local)); } catch (e) {}
    }

    function parentOf(p) { return p.slice(0, p.lastIndexOf('/')); }
    function nameOf(p) { return p.split('/').pop(); }

    /* --- leitura do HD real (XHR sincrono: simples, e so no simulador) --- */
    function relOf(p) { return p === LIB ? '' : (p.indexOf(LIB + '/') === 0 ? p.slice(LIB.length + 1) : null); }
    function get(url) {
        var x = new XMLHttpRequest();
        try { x.open('GET', url, false); x.send(); } catch (e) { return null; }
        return x.status === 200 ? x.responseText : null;
    }
    function rawUrl(p) { return '/hd/raw/' + relOf(p).split('/').map(encodeURIComponent).join('/'); }
    function hdStat(p) {
        var r = REAL ? relOf(p) : null;
        if (r === null) { return null; }
        var t = get('/hd/stat?p=' + encodeURIComponent(r));
        return t ? JSON.parse(t) : null;
    }
    function hdList(p) {
        var r = REAL ? relOf(p) : null;
        if (r === null) { return []; }
        var t = get('/hd/list?p=' + encodeURIComponent(r));
        return t ? (JSON.parse(t) || []) : [];
    }
    function uriOf(p) { return (REAL && relOf(p) !== null) ? location.origin + rawUrl(p) : 'file://' + p; }
    window.__fileUrl = uriOf;            // fileUrl() do app

    function mkFile(p, size, mtime) {
        return {
            name: nameOf(p), fullPath: p, isDirectory: false, isFile: true,
            get fileSize() { return FS.files[p] !== undefined ? (FS.sizes[p] || FS.files[p].length) : (size || 0); },
            modified: new Date(mtime || now),
            get parent() { return mkDir(parentOf(p)); },
            toURI: function () { return uriOf(p); },
            openStream: function (mode, ok, err) {
                _st(function () {
                    if (FS.files[p] === undefined && REAL && mode !== 'w') {   // 1a leitura: copia do HD real
                        var txt = get(rawUrl(p));
                        if (txt !== null) { FS.files[p] = txt; }
                    }
                    if (FS.files[p] === undefined && mode !== 'w') { err && err({ message: 'NotFound' }); return; }
                    if (mode === 'w') { FS.files[p] = ''; }
                    ok({
                        get bytesAvailable() { return (FS.files[p] || '').length; },
                        read: function () { return FS.files[p] || ''; },
                        write: function (t) { FS.files[p] = (FS.files[p] || '') + t; },
                        close: function () {}
                    });
                }, 3);
            }
        };
    }
    function mkDir(p, mtime) {
        return {
            name: nameOf(p), fullPath: p, isDirectory: true, isFile: false,
            modified: new Date(mtime || now),
            get parent() { return mkDir(parentOf(p)); },
            toURI: function () { return uriOf(p); },
            listFiles: function (ok) {
                _st(function () {
                    var out = [], seen = {};
                    Object.keys(FS.dirs).forEach(function (d) { if (parentOf(d) === p) { out.push(mkDir(d)); seen[nameOf(d)] = 1; } });
                    Object.keys(FS.files).forEach(function (f) { if (parentOf(f) === p) { out.push(mkFile(f)); seen[nameOf(f)] = 1; } });
                    hdList(p).forEach(function (e) {
                        if (seen[e.name]) { return; }
                        out.push(e.isDir ? mkDir(p + '/' + e.name, e.mtime) : mkFile(p + '/' + e.name, e.size, e.mtime));
                    });
                    ok(out);
                }, 3);
            },
            createFile: function (n) { var f = p + '/' + n; if (FS.files[f] !== undefined) { throw new Error('exists'); } FS.files[f] = ''; return mkFile(f); },
            createDirectory: function (n) { FS.dirs[p + '/' + n] = true; return mkDir(p + '/' + n); },
            deleteFile: function (f, ok) { delete FS.files[f]; _st(function () { ok && ok(); }, 3); }
        };
    }
    window.tizen = {
        filesystem: {
            listStorages: function (ok) {
                _st(function () { ok(NOHD ? [] : [{ label: 'removable_sda1', type: 'EXTERNAL', state: 'MOUNTED' }]); }, 3);
            },
            resolve: function (p, ok, err) {
                p = String(p).replace(/^file:\/\//, '');
                if (p === 'removable_sda1') { p = ROOT; }
                _st(function () {
                    if (FS.dirs[p]) { ok(mkDir(p)); return; }
                    if (FS.files[p] !== undefined) { ok(mkFile(p)); return; }
                    var st = hdStat(p);
                    if (st) { ok(st.isDir ? mkDir(p, st.mtime) : mkFile(p, st.size, st.mtime)); }
                    else if (err) { err({ message: 'NotFoundError: ' + p }); }
                }, 3);
            },
            addStorageStateChangeListener: function () {}
        }
    };

    /* duracao dos episodios no modo real: a do progresso.json do HD (senao 23 min) */
    var DUR = {};
    if (REAL) {
        try {
            var prog = JSON.parse(get('/hd/raw/progresso.json') || '{}');
            Object.keys(prog).forEach(function (k) { if (prog[k] && prog[k].duration) { DUR[nameOf(k)] = prog[k].duration; } });
        } catch (e) {}
    }

    /* "video": o still do episodio (thumbs/<arquivo>.jpg) atras da pagina */
    var fakeVideo = null;
    function showFakeVideo(uri) {
        if (!fakeVideo) {
            fakeVideo = document.createElement('div');
            fakeVideo.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;z-index:-1;' +
                'background:#15182A center/cover no-repeat;display:none';
            document.body.appendChild(fakeVideo);
        }
        var name = decodeURIComponent(String(uri).split('/').pop());
        fakeVideo.style.backgroundImage = REAL ? 'url("' + rawUrl(LIB + '/thumbs/' + name + '.jpg') + '")' : 'none';
        fakeVideo.style.display = uri ? 'block' : 'none';
    }

    /* ---------- AVPlay simulado ---------- */
    var AV = window.AV = { state: 'NONE', pos: 0, dur: 2400000, L: null, seeking: false, timer: null, opens: 0, seekN: 0, frozen: false };
    // ?bad=600-606 : trecho com defeito (s). Tocar/chegar nele congela (playtime repete);
    // congelado, todo seek falha com PLAYER_ERROR_SEEK_FAILED (como visto na TV). open() destrava.
    var BAD = q.bad ? q.bad.split('-').map(function (x) { return +x * 1000; }) : null;
    function inBad(ms) { return !!BAD && ms >= BAD[0] && ms < BAD[1]; }
    function emit() {
        if (AV.timer) { return; }
        AV.timer = _si(function () {
            if (AV.state !== 'PLAYING' || AV.seeking || !AV.L) { return; }
            if (!AV.frozen) {
                AV.pos += 250;
                if (inBad(AV.pos)) { AV.frozen = true; ev('CONGELOU em ' + Math.round(AV.pos / 1000) + 's'); }
            }
            AV.L.oncurrentplaytime(AV.pos);
        }, 250);
    }
    function stopEmit() { if (AV.timer) { _ci(AV.timer); AV.timer = null; } }
    function doSeek(ms, delay, ok, callOk) {
        AV.seeking = true;
        var id = AV.seekId = (AV.seekId || 0) + 1;     // seek novo substitui o anterior (como no AVPlay)
        _st(function () {
            if (id !== AV.seekId) { return; }
            AV.seeking = false;
            AV.pos = Math.max(0, ms - 1800);           // cai no keyframe anterior
            if (inBad(ms)) { AV.pos = ms; }            // no trecho ruim "chega" exato no alvo...
            if (inBad(AV.pos)) { AV.frozen = true; ev('CONGELOU (seek) em ' + Math.round(AV.pos / 1000) + 's'); }   // ...e congela
            if (callOk && ok) { ok(); }
        }, delay);
    }
    window.webapis = { avplay: {
        open: function (u) {
            var nm = decodeURIComponent(String(u).split('/').pop());
            AV.dur = q.dur ? +q.dur * 1000 : (DUR[nm] || (REAL ? 1380000 : 2400000));
            showFakeVideo(u);
            AV.opens++; AV.state = 'IDLE'; AV.pos = 0; AV.seeking = false; AV.frozen = false; AV.readySeek = false; AV.playDuringSeek = false; AV.seekId = (AV.seekId || 0) + 1; ev('open #' + AV.opens); },
        getState: function () { return AV.state; },
        setDisplayRect: function () {}, setDisplayMethod: function () {},
        setListener: function (l) { AV.L = l; },
        prepareAsync: function (ok) { _st(function () { AV.state = 'READY'; ok(); }, 30); },
        getDuration: function () { return AV.dur; },
        // faixas falsas (?tracks=0 desliga): 2 audios, legenda forcada + PT + EN
        getTotalTrackInfo: function () {
            if (q.tracks === '0') { return []; }
            return [
                { index: 0, type: 'VIDEO', extra_info: '{}' },
                { index: 1, type: 'AUDIO', extra_info: '{"language":"por","name":"Dublado"}' },
                { index: 2, type: 'AUDIO', extra_info: '{"language":"eng"}' },
                { index: 3, type: 'TEXT',  extra_info: '{"track_lang":"por","name":"Forced"}' },
                { index: 4, type: 'TEXT',  extra_info: '{"track_lang":"por"}' },
                { index: 5, type: 'TEXT',  extra_info: '{"track_lang":"eng"}' }
            ];
        },
        getCurrentStreamInfo: function () { return q.tracks === '0' ? [] : [{ type: 'AUDIO', index: 1 }]; },
        setSilentSubtitle: function () {}, setSelectTrack: function () {}, setExternalSubtitlePath: function () {},
        play: function () {
            if (TV === 'h1' && AV.seeking) { AV.playDuringSeek = true; }
            if ((TV === 'h2' || TV === 'hall') && AV.readySeek) { AV.frozen = true; ev('CONGELOU (seek no READY)'); }
            AV.state = 'PLAYING'; killTimers();
            if (S === 'stuck' && AV.stuck) {           // travado apos o seek no READY: so eventos de buffer
                AV.seeking = true;
                _st(function () { AV.L && AV.L.onbufferingstart(); }, 100);
                _st(function () { AV.L && AV.L.onbufferingcomplete(); }, 900);
            }
            emit();
        },
        pause: function () { AV.state = 'PAUSED'; },
        stop: function () { AV.state = 'IDLE'; }, close: function () { AV.state = 'NONE'; showFakeVideo(null); },
        seekTo: function (ms, ok, err) {
            AV.seekN++;
            T.seeks.push(AV.state + '@' + Math.round(ms / 1000) + 's');
            ev('seekTo ' + Math.round(ms / 1000) + 's (' + AV.state + ')');
            if (AV.frozen) {                            // player congelado: seek sempre falha
                ev('SEEK_FAILED (congelado)');
                _st(function () { if (err) { err({ message: 'PLAYER_ERROR_SEEK_FAILED' }); } else { throw new Error('Script error'); } }, 300);
                return;
            }
            if (TV) {                                   // modelos do AVPlay da TV (ver topo)
                var inReady = AV.state === 'READY';
                AV.seeking = true; AV.playDuringSeek = false;
                var sid = AV.seekId = (AV.seekId || 0) + 1;
                _st(function () {
                    if (sid !== AV.seekId) { return; }
                    AV.seeking = false;
                    AV.pos = inReady ? ms : Math.max(0, ms - 1800);
                    if (TV === 'h1' && inReady && AV.playDuringSeek) { AV.frozen = true; ev('CONGELOU (play com o seek em andamento)'); }
                    if (TV === 'h2' && inReady) { AV.readySeek = true; if (AV.state === 'PLAYING') { AV.frozen = true; ev('CONGELOU (seek no READY)'); } }
                    if ((TV === 'h3' || TV === 'hall') && !inReady) { AV.frozen = true; ev('CONGELOU (seek tocando)'); }
                    if (TV === 'hall' && inReady) { AV.readySeek = true; if (AV.state === 'PLAYING') { AV.frozen = true; } }
                    if (ok) { ok(); }
                }, q.seekms ? +q.seekms : 1500);
                return;
            }
            if (S === 'ok') { doSeek(ms, 2000, ok, true); }
            else if (S === 'nocb') { doSeek(ms, 2000, ok, false); }                      // callback nunca vem
            else if (S === 'ignored') {                                                   // READY: "ok" mas ignora
                if (AV.state === 'READY') { _st(function () { ok && ok(); }, 300); }
                else { doSeek(ms, 2000, ok, true); }
            }
            else if (S === 'slow') { doSeek(ms, 15000, ok, true); }                      // 15 s sem playtime
            else if (S === 'error') { _st(function () { err && err({ message: 'PLAYER_ERROR_SEEK_FAILED' }); }, 300); }
            else if (S === 'onerror') {                                                   // 1a abertura: erro do player
                if (AV.opens === 1) {
                    var openNo = AV.opens;                 // erro pertence a esta sessao (close() descarta)
                    _st(function () { if (AV.opens === openNo && AV.state !== 'NONE') { AV.L.onerror('PLAYER_ERROR_INVALID_OPERATION'); } }, 500);
                }
                else { doSeek(ms, 2000, ok, true); }
            }
            else if (S === 'late') {          // toca do zero ~1,5 s, depois o seek "pega" e leva 15 s (USB lento)
                if (AV.state === 'READY' && !AV.lateDone) {
                    AV.lateDone = true;
                    _st(function () { doSeek(ms, 15000, ok, true); }, 1500);
                } else { doSeek(ms, 3000, ok, true); }
            }
            else if (S === 'stuck') {         // seek no READY trava o player (sem playtime/callback) ate outro seek
                if (AV.state === 'READY') { AV.stuck = true; }
                else { AV.stuck = false; doSeek(ms, 3000, ok, true); }
            }
            else if (S === 'lateslow') {      // idem, mas TODO seek leva 15 s sem playtime
                if (AV.state === 'READY' && !AV.lateDone) {
                    AV.lateDone = true;
                    _st(function () { doSeek(ms, 15000, ok, true); }, 1500);
                } else { doSeek(ms, 15000, ok, true); }
            }
        }
    } };
    window.addEventListener('load', function () {
        var origToast = null;
        _st(function () {
            origToast = UI.toast;
            UI.toast = function (m) { T.toasts.push(m); ev('TOAST ' + m); origToast(m); };
        }, 0);
    });
})();
