/* ============================================================================
 * AmorecoFlix - js/library.js
 * Meta:    le AmorecoFlix/meta/biblioteca.json (gerado no PC pelo
 *          metadados.ps1): sinopse, ano, generos, titulos de episodio, fundo
 *          16:9 e poster. Sem o arquivo, tudo continua funcionando com os
 *          nomes das pastas.
 * Library: os TITULOS da biblioteca (series, animes, filmes e colecoes) com
 *          temporadas e episodios, lidos das pastas do HD em segundo plano.
 *          Fica em cache no localStorage para o Inicio aparecer na hora.
 *
 * Chave de titulo = caminho relativo a biblioteca, como no progresso.json:
 *   "Series/The Vampire Diaries", "Animes/Death Parade",
 *   "Filmes/Anaconda (2025) [1080p].mkv", "Filmes/Vingadores".
 * ==========================================================================*/

/* caminho relativo a biblioteca ("Series/X/X - 1a Temporada/ep.mkv") */
function relPath(fullPath) {
    var base = App.libraryDir && App.libraryDir.fullPath, p = String(fullPath || '');
    if (base && p.indexOf(base + '/') === 0) { return p.slice(base.length + 1); }
    var m = '/' + LIBRARY_DIR.toLowerCase() + '/', i = p.toLowerCase().indexOf(m);
    return i !== -1 ? p.slice(i + m.length) : p;
}
/* chave do titulo de um arquivo: categoria/pasta, ou o proprio filme solto */
function titleKeyOf(fullPath) {
    var parts = relPath(fullPath).split('/');
    if (parts.length >= 3) { return parts[0] + '/' + parts[1]; }
    return parts.length === 2 ? parts.join('/') : '';
}
function libFull(rel) {
    var base = App.libraryDir && App.libraryDir.fullPath;
    return base ? base + '/' + rel : rel;
}


var Meta = (function () {

    var data = null;          // titulos do json; null = ainda nao leu

    function load(libDir, force) {
        if (!libDir || !libDir.fullPath) { return; }
        if (data !== null && !force) { return; }
        readTextFile(libDir.fullPath + '/meta/biblioteca.json', function (txt) {
            try {
                var o = JSON.parse(txt);
                data = (o && o.titulos) || {};
                console.log('[meta] biblioteca.json:', Object.keys(data).length, 'titulos');
            } catch (e) { console.warn('[meta] json invalido:', e && e.message); data = data || {}; }
            Library.changed('meta');
        }, function () { console.log('[meta] biblioteca.json ausente (rode metadados.ps1 no PC)'); data = data || {}; });
    }

    function title(key) { return (data && data[key]) || null; }

    /* [temporada, episodio] de um arquivo, pelo mapa do metadados.ps1 */
    function fileEp(key, fileName) {
        var t = title(key);
        return (t && t.arquivos && t.arquivos[fileName]) || null;
    }
    function episode(key, s, e) {
        var t = title(key), ts = t && t.temporadas && t.temporadas[String(s)];
        return (ts && ts.episodios && ts.episodios[String(e)]) || null;
    }
    function film(key, fileName) {
        var t = title(key);
        return (t && t.filmes && t.filmes[fileName]) || null;
    }
    function img(dir, file) { return file ? fileUrl(libFull('meta/' + dir + '/' + file)) : null; }
    function backdrop(key) { var t = title(key); return t ? img('fundos', t.fundo) : null; }
    function poster(key)   { var t = title(key); return t ? img('posters', t.poster) : null; }

    return { load: load, title: title, fileEp: fileEp, episode: episode, film: film,
             backdrop: backdrop, poster: poster, ready: function () { return data !== null; } };
})();


var Library = (function () {

    var CACHE_KEY = 'amorecoflix.library.v1';
    var titles = [], byKey = {};
    var scanning = false, scanned = false, listeners = [];
    var relative = false;     // titulos do cache: caminhos ainda sem o HD montado na frente

    /* O cache guarda os caminhos RELATIVOS a biblioteca: a TV pode montar o
       HD com outro nome (outra porta, HD que foi ao PC) e, ate a leitura das
       pastas terminar, "Proximos" e o destaque apontariam para o caminho velho */
    function mapPaths(list, fn) {
        list.forEach(function (t) {
            t.path = fn(t.path);
            t.seasons.forEach(function (s) {
                s.path = fn(s.path);
                s.eps.forEach(function (e) { e.path = fn(e.path); });
            });
        });
        return list;
    }
    try {
        var cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached && cached.length) { setTitles(mapPaths(cached, relPath)); relative = true; }
    } catch (e) {}

    /* HD achado: os titulos do cache ganham o caminho da montagem atual */
    function rebase(libDir) {
        if (!relative || !libDir || !libDir.fullPath) { return; }
        relative = false;
        mapPaths(titles, function (p) { return p.charAt(0) === '/' ? p : libDir.fullPath + '/' + p; });
    }

    function setTitles(list) {
        titles = list;
        byKey = {};
        list.forEach(function (t) { byKey[t.key] = t; });
    }

    function onChange(fn) { listeners.push(fn); }

    /* o biblioteca.json chegou depois da leitura das pastas: renumera os
       episodios pelo mapa dele (ex.: "02 O Comeco de Tudo.mp4" -> E2) */
    function remap() {
        titles.forEach(function (t) {
            t.seasons.forEach(function (s) {
                s.eps.forEach(function (ep) {
                    var fe = Meta.fileEp(t.key, ep.name);
                    if (fe) { ep.s = fe[0]; ep.e = fe[1]; }
                });
            });
        });
    }

    function changed(why) {
        if (why === 'meta') { remap(); }
        listeners.forEach(function (fn) { try { fn(why); } catch (e) { console.error('[library] aviso:', e && e.message); } });
    }

    /* ---------- leitura das pastas ---------- */

    function epOf(key, entry, seasonNum) {
        var fe = Meta.fileEp(key, entry.name), i = UI.epInfo(entry.name) || {};
        return {
            name: entry.name, path: entry.file.fullPath, mod: entry.mod || 0,
            s: fe ? fe[0] : (i.s || seasonNum || 1),
            e: fe ? fe[1] : (i.e != null ? i.e : null)
        };
    }

    /* lista uma pasta (promessa simples com callback) */
    function list(dirPath, cb) {
        try {
            tizen.filesystem.resolve(dirPath, function (d) { listDirectory(d, cb); },
                function () { cb([]); }, 'r');
        } catch (e) { cb([]); }
    }

    /* fila: no maximo 2 listagens ao mesmo tempo (HD USB) */
    var queue = [], running = 0;
    function enqueue(job) { queue.push(job); pump(); }
    function pump() {
        while (running < 2 && queue.length) {
            running++;
            (queue.shift())(function () { running--; pump(); });
        }
    }

    function scan(libDir) {
        rebase(libDir);
        if (scanning || !libDir || !libDir.fullPath || !window.tizen) { return; }
        scanning = true;
        var t0 = Date.now(), out = [], pending = 0;
        var base = libDir.fullPath;

        function done() {
            if (--pending > 0) { return; }
            out.sort(function (a, b) { return naturalCompare(a.name.toLowerCase(), b.name.toLowerCase()); });
            out.forEach(function (t) {
                t.seasons.sort(function (a, b) { return a.num - b.num; });
                t.added = 0;
                t.seasons.forEach(function (s) { s.eps.forEach(function (e) { if (e.mod > t.added) { t.added = e.mod; } }); });
            });
            setTitles(out);
            scanning = false;
            scanned = true;
            var nEps = 0;
            out.forEach(function (t) { t.seasons.forEach(function (s) { nEps += s.eps.length; }); });
            console.log('[library] ' + out.length + ' titulos, ' + nEps + ' videos em ' + (Date.now() - t0) + ' ms');
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(mapPaths(JSON.parse(JSON.stringify(out)), relPath))); } catch (e) {}
            changed('scan');
        }

        function addSeason(t, num, name, path) {
            pending++;
            enqueue(function (next) {
                list(path, function (entries) {
                    var eps = entries.filter(function (e) { return !e.isDir; })
                                     .map(function (e) { return epOf(t.key, e, num); });
                    if (eps.length) {
                        // pasta plana com episodios de temporadas diferentes (raro): separa
                        var groups = {};
                        eps.forEach(function (e) { (groups[e.s] = groups[e.s] || []).push(e); });
                        Object.keys(groups).forEach(function (s) {
                            t.seasons.push({ num: +s, name: name, path: path, eps: groups[s] });
                        });
                    }
                    next(); done();
                });
            });
        }

        ['Series', 'Animes', 'Filmes'].forEach(function (cat) {
            pending++;
            enqueue(function (next) {
                list(base + '/' + cat, function (entries) {
                    entries.forEach(function (en) {
                        var key = cat + '/' + en.name;
                        if (cat === 'Filmes' && !en.isDir) {
                            out.push({ key: key, kind: 'filme', name: en.name, path: en.file.fullPath,
                                       seasons: [{ num: 0, name: '', path: base + '/' + cat,
                                                   eps: [{ name: en.name, path: en.file.fullPath, mod: en.mod || 0, s: 0, e: null }] }] });
                            return;
                        }
                        if (!en.isDir) { return; }
                        var t = { key: key, kind: cat === 'Filmes' ? 'colecao' : (cat === 'Animes' ? 'anime' : 'serie'),
                                  name: en.name, path: en.file.fullPath, seasons: [] };
                        out.push(t);
                        pending++;
                        enqueue(function (next2) {
                            list(en.file.fullPath, function (inner) {
                                var hasLoose = false;
                                inner.forEach(function (x) {
                                    if (x.isDir) {
                                        var n = seasonNumber(x.name);
                                        if (n || t.kind === 'colecao') { addSeason(t, n, x.name, x.file.fullPath); }
                                    } else { hasLoose = true; }
                                });
                                if (hasLoose) { addSeason(t, 0, en.name, en.file.fullPath); }
                                next2(); done();
                            });
                        });
                    });
                    next(); done();
                });
            });
        });
    }

    /* ---------- consultas ---------- */

    function all() { return titles; }
    function get(key) { return byKey[key] || null; }
    function ofPath(fullPath) { return get(titleKeyOf(fullPath)); }

    /* episodios em ordem (temporada, episodio/nome) */
    function episodes(t) {
        var out = [];
        if (!t) { return out; }
        t.seasons.forEach(function (s) {
            var eps = s.eps.slice().sort(function (a, b) {
                if (a.e != null && b.e != null && a.s === b.s) { return a.e - b.e; }
                return naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
            });
            out = out.concat(eps);
        });
        return out;
    }
    function seasonsOf(t) { return t ? t.seasons.filter(function (s) { return s.eps.length; }) : []; }

    /* nome para mostrar: a pasta (como voce organizou), ou o titulo do TMDB
       quando a pasta e abreviada ("FMA Brotherhood") ou e um filme */
    function displayName(t) {
        if (!t) { return ''; }
        var m = Meta.title(t.key);
        if (t.kind === 'filme') { return (m && m.titulo) || UI.cleanName(t.name); }
        if (!m || !m.titulo) { return t.name; }
        var folder = t.name.toLowerCase();
        if ((m.original || '').toLowerCase() === folder || m.titulo.toLowerCase() === folder) { return t.name; }
        return m.titulo;
    }

    /* titulo do episodio ("Alcohol Poison") ou "Episodio 7" / nome limpo */
    function epTitle(t, ep) {
        if (!ep) { return ''; }
        if (t && t.kind === 'colecao') {
            var f = Meta.film(t.key, ep.name);
            return (f && f.titulo) || UI.cleanName(ep.name);
        }
        if (t && t.kind === 'filme') { return displayName(t); }
        var m = t && ep.e != null ? Meta.episode(t.key, ep.s, ep.e) : null;
        if (m && m.titulo) { return m.titulo; }
        return ep.e != null ? 'Episódio ' + ep.e : UI.cleanName(ep.name);
    }
    /* "T1 E7" */
    function epCode(ep) {
        if (!ep || ep.e == null) { return ''; }
        return (ep.s ? 'T' + ep.s + ' ' : '') + 'E' + ep.e;
    }
    /* duracao (ms) conhecida: progresso, cache de miniatura ou TMDB */
    function epDuration(t, ep) {
        var rec = ProgressStore.get(ep.path), th = Thumbs.get(ep.path), d = 0;
        if (rec && rec.duration > 0 && rec.duration < 4294967000) { d = rec.duration; }
        else if (th && th.d) { d = th.d; }
        else if (t) {
            var m = t.kind === 'filme' ? Meta.title(t.key)
                  : t.kind === 'colecao' ? Meta.film(t.key, ep.name)
                  : (ep.e != null ? Meta.episode(t.key, ep.s, ep.e) : null);
            if (m && m.min) { d = m.min * 60000; }
        }
        return d;
    }

    /* progresso de um titulo:
       { watched, total, pct, current (ep em andamento), currentRec,
         next (o que o botao principal toca), last, lastUpdated, isNew } */
    function progressOf(t) {
        var eps = episodes(t), watched = 0, current = null, currentRec = null, last = null, lastRec = null;
        eps.forEach(function (ep) {
            var r = ProgressStore.get(ep.path);
            if (!r) { return; }
            if (r.done) { watched++; }
            if (!lastRec || (r.updated || 0) > (lastRec.updated || 0)) { lastRec = r; last = ep; }
            if (!r.done && r.position >= 1000 && (!currentRec || (r.updated || 0) > (currentRec.updated || 0))) {
                currentRec = r; current = ep;
            }
        });
        var next = current;
        if (!next && last) {                         // continua depois do ultimo visto
            var i = eps.indexOf(last);
            for (var j = i + 1; j < eps.length; j++) {
                var rj = ProgressStore.get(eps[j].path);
                if (!rj || !rj.done) { next = eps[j]; break; }
            }
        }
        if (!next) {                                  // primeiro ainda nao visto
            for (var k = 0; k < eps.length; k++) {
                var rk = ProgressStore.get(eps[k].path);
                if (!rk || !rk.done) { next = eps[k]; break; }
            }
        }
        var lastUpdated = lastRec ? (lastRec.updated || 0) : 0;
        var month = Date.now() - 30 * 86400000, isNew = false;
        eps.forEach(function (ep) {
            if (isNew || !ep.mod || ep.mod < month || ep.mod <= lastUpdated) { return; }
            var r = ProgressStore.get(ep.path);
            if (!r || !r.done) { isNew = true; }
        });
        return {
            watched: watched, total: eps.length, pct: eps.length ? watched / eps.length * 100 : 0,
            current: current, currentRec: currentRec, next: next, last: last,
            lastUpdated: lastUpdated, isNew: isNew, allDone: eps.length > 0 && watched === eps.length
        };
    }

    /* "Proximos episodios": voce terminou o episodio N e o N+1 existe e nao
       foi comecado (nem esta no Continuar). Mais recente primeiro. */
    function nextUp(limit) {
        var out = [];
        titles.forEach(function (t) {
            if (t.kind === 'filme') { return; }
            var p = progressOf(t);
            if (p.current || !p.last || !p.next || p.next === p.last) { return; }
            var lr = ProgressStore.get(p.last.path);
            if (!lr || !lr.done || ProgressStore.get(p.next.path)) { return; }
            out.push({ title: t, ep: p.next, updated: p.lastUpdated });
        });
        out.sort(function (a, b) { return b.updated - a.updated; });
        return limit ? out.slice(0, limit) : out;
    }

    return {
        scan: scan, changed: changed, onChange: onChange,
        all: all, get: get, ofPath: ofPath, episodes: episodes, seasonsOf: seasonsOf,
        displayName: displayName, epTitle: epTitle, epCode: epCode, epDuration: epDuration,
        progressOf: progressOf, nextUp: nextUp,
        ready: function () { return scanned || titles.length > 0; },
        scanned: function () { return scanned; }
    };
})();
