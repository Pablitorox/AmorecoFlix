/* ============================================================================
 * AmorecoFlix - js/screens/series.js
 * Pagina do titulo (tela 2 do prototipo): serie/anime, filme ou colecao.
 * Fundo 16:9, sinopse, selos, botao principal (Continuar / Assistir /
 * Assistir de novo), "Do inicio", marcar temporada como vista e a fileira
 * de episodios com seletor de temporada.
 * ==========================================================================*/

var Series = (function () {

    function $(id) { return document.getElementById(id); }
    var el = {
        screen: $('screen-series'), img: $('series-img'), kicker: $('series-kicker'), title: $('series-title'),
        text: $('series-text'), chips: $('series-chips'), play: $('series-play'), restart: $('series-restart'),
        mark: $('series-mark'), eps: $('series-eps'), epsH: $('series-eps-h'), seasonBtn: $('season-btn'),
        rail: $('series-rail')
    };
    var cur = { key: null, season: null };
    var saved = { group: null, key: null };
    var scrollRail = railScroller(el.rail);

    function epPct(ep) {
        var r = ProgressStore.get(ep.path);
        if (!r) { return null; }
        if (r.done) { return 100; }
        return UI.validDur(r.duration) && r.position > 0 ? r.position / r.duration * 100 : null;
    }
    function shortCode(t, ep) {
        var code = Library.epCode(ep);
        return Library.seasonsOf(t).length > 1 ? code : code.replace(/^T\d+ /, '');
    }
    function seasonLabel(s) { return s.num ? 'Temporada ' + s.num : 'Filmes'; }
    function seasonsList(t) {
        var by = {}, out = [];
        Library.seasonsOf(t).forEach(function (s) {
            if (!by[s.num]) { by[s.num] = { num: s.num, eps: [] }; out.push(by[s.num]); }
            by[s.num].eps = by[s.num].eps.concat(s.eps);
        });
        out.sort(function (a, b) { return a.num - b.num; });
        return out;
    }
    function seasonEps(t, num) {
        return Library.episodes(t).filter(function (e) { return t.kind === 'colecao' || e.s === num || (num === 0 && !e.s); });
    }
    function allDone(eps) {
        return eps.length > 0 && eps.every(function (e) { var r = ProgressStore.get(e.path); return r && r.done; });
    }

    /* selo de qualidade pelo nome dos arquivos ([1080p], 2160p, 4K) */
    function quality(t) {
        var best = 0;
        Library.episodes(t).forEach(function (e) {
            var m = /\b(2160p|4k|1080p|720p|480p)\b/i.exec(e.name);
            if (m) { var v = /2160|4k/i.test(m[1]) ? 2160 : parseInt(m[1], 10); if (v > best) { best = v; } }
        });
        return best >= 2160 ? '4K' : best ? best + 'p' : '';
    }
    function hasSkip(t) {
        return Library.episodes(t).some(function (e) { var s = SkipData.get(e.name); return s && s.op; });
    }

    function kicker(t, m) {
        var parts = [kindLabel(t).toUpperCase()];
        if (m && m.ano) { parts.push(m.ano); }
        if (m && m.generos && m.generos.length) { parts.push(m.generos.slice(0, 2).join(', ').toUpperCase()); }
        if (t.kind === 'filme') {
            var d = Library.epDuration(t, Library.episodes(t)[0]);
            if (d) { parts.push(fmtMinutes(d).toUpperCase()); }
        } else if (t.kind === 'colecao') {
            parts.push(Library.episodes(t).length + ' FILMES');
        } else {
            var ns = seasonsList(t).length, ne = Library.episodes(t).length;
            parts.push(ns > 1 ? ns + ' TEMPORADAS' : ne + (ne === 1 ? ' EPISÓDIO' : ' EPISÓDIOS'));
        }
        return parts.join(' · ');
    }

    /* ---------- topo ---------- */

    function renderInfo(t) {
        var m = Meta.title(t.key), p = Library.progressOf(t), name = Library.displayName(t);
        var first = Library.episodes(t)[0];
        Art.set(el.img, Meta.backdrop(t.key) || (first ? ThumbsFolder.get(first.name) : null), true);
        el.kicker.textContent = kicker(t, m);
        el.title.textContent = name;
        el.title.className = 'hero-title' + (name.length > 28 ? ' t-sm' : name.length > 16 ? ' t-md' : '');
        el.text.textContent = (m && m.sinopse) || '';
        el.text.hidden = !el.text.textContent;

        var chips = [], q = quality(t);
        if (q) { chips.push(q); }
        if (hasSkip(t)) { chips.push('Pular abertura'); }
        if (t.kind === 'filme') { if (p.allDone) { chips.push('Assistido'); } }
        else if (p.total) { chips.push(p.watched + ' de ' + p.total + (t.kind === 'colecao' ? ' vistos' : ' assistidos')); }
        if (m && m.nota) { chips.push('★ ' + String(m.nota).replace('.', ',')); }
        el.chips.innerHTML = chips.map(function (c) { return '<span class="info-chip">' + escapeHtml(c) + '</span>'; }).join('');

        // botao principal
        var film = t.kind === 'filme';
        var rec = p.current ? ProgressStore.get(p.current.path) : null;
        if (p.current && rec) {
            var rest = UI.validDur(rec.duration) ? ' · ' + fmtMinutes(rec.duration - rec.position) : '';
            el.play.innerHTML = Icons.svg('play', 28) + (film || t.kind === 'colecao' && !p.current.e ? 'Continuar' : 'Continuar ' + shortCode(t, p.current)) + rest;
            el.play.onclick = function () { openVideoByPath(p.current.path, rec.position); };
        } else if (p.allDone || !p.next) {
            var ep0 = Library.episodes(t)[0];
            el.play.innerHTML = Icons.svg('play', 28) + (p.allDone ? 'Assistir de novo' : 'Assistir');
            el.play.onclick = function () { if (ep0) { openVideoByPath(ep0.path, 0); } };
        } else {
            el.play.innerHTML = Icons.svg('play', 28) + (film || t.kind === 'colecao' || p.next.e == null ? 'Assistir' : 'Assistir ' + shortCode(t, p.next));
            el.play.onclick = function () { openVideoByPath(p.next.path, savedPos(p.next.path)); };
        }
        // do inicio: so com algo em andamento
        el.restart.hidden = !(p.current && rec);
        el.restart.innerHTML = Icons.svg('restart', 26) + 'Do início';
        el.restart.onclick = function () { if (p.current) { openVideoByPath(p.current.path, 0); } };

        // marcar visto: temporada (serie), filme, colecao inteira
        var target = film ? Library.episodes(t) : t.kind === 'colecao' ? Library.episodes(t) : seasonEps(t, cur.season);
        var done = allDone(target);
        el.mark.innerHTML = Icons.svg(done ? 'close' : 'check', 28, 2.2);
        el.mark.classList.toggle('is-on', done);
        var what = film ? 'o filme' : t.kind === 'colecao' ? 'a coleção' : 'a temporada ' + cur.season;
        el.mark.setAttribute('aria-label', (done ? 'Desmarcar ' : 'Marcar ') + what + ' como vist' + (film ? 'o' : 'a'));
        el.mark.onclick = function () {
            target.forEach(function (e) { ProgressStore.setDone(e.path, !done); });
            UI.toast(done ? 'Marcação removida.' : (film ? 'Filme marcado como visto.' : t.kind === 'colecao' ? 'Coleção marcada como vista.' : 'Temporada ' + cur.season + ' marcada como vista.'));
            refresh();
        };
    }

    /* ---------- episodios ---------- */

    function epOptions(t, ep) {
        var r = ProgressStore.get(ep.path), inProg = r && !r.done && r.position >= 1000;
        Options.open({
            title: Library.epTitle(t, ep), sub: Library.displayName(t) + (ep.e != null ? ' · ' + Library.epCode(ep) : ''),
            art: ThumbsFolder.get(ep.name) || Meta.backdrop(t.key), pct: epPct(ep),
            actions: [
                { icon: 'play', label: inProg ? 'Continuar de ' + fmtTime(r.position) : 'Assistir', run: function () { openVideoByPath(ep.path, savedPos(ep.path)); } },
                inProg ? { icon: 'restart', label: 'Assistir do início', run: function () { openVideoByPath(ep.path, 0); } } : null,
                r && r.done
                    ? { icon: 'close', label: 'Marcar como não assistido', run: function () { ProgressStore.setDone(ep.path, false); refresh(); } }
                    : { icon: 'check', label: 'Marcar como assistido', run: function () { ProgressStore.setDone(ep.path, true); refresh(); } }
            ]
        });
    }

    function epSub(t, ep, isCur) {
        var r = ProgressStore.get(ep.path), d = Library.epDuration(t, ep);
        if (isCur && r && UI.validDur(r.duration)) { return 'Você parou aqui · ' + fmtMinutes(r.duration - r.position) + ' restantes'; }
        if (t.kind === 'colecao') {
            var f = Meta.film(t.key, ep.name);
            return [f && f.ano, fmtMinutes(d), r && r.done ? 'Assistido' : ''].filter(Boolean).join(' · ');
        }
        return [fmtMinutes(d), r && r.done ? 'Assistido' : ''].filter(Boolean).join(' · ');
    }

    function renderEps(t) {
        if (t.kind === 'filme') { el.eps.hidden = true; return; }
        el.eps.hidden = false;
        var seasons = seasonsList(t);
        var multi = seasons.length > 1;
        el.epsH.textContent = t.kind === 'colecao' ? 'Filmes' : 'Episódios';
        el.seasonBtn.hidden = !multi;
        var s = seasons.filter(function (x) { return x.num === cur.season; })[0] || seasons[0];
        if (s) { cur.season = s.num; }
        el.seasonBtn.innerHTML = '<span>' + (s ? seasonLabel(s) : '') + '</span>' + Icons.svg('chevDown', 22, 2.2);

        var p = Library.progressOf(t), curPath = p.current ? p.current.path : null;
        var eps = s ? seasonEps(t, s.num) : [];
        el.rail.innerHTML = '';
        el.rail.style.transform = '';
        var focusCard = null;
        eps.forEach(function (ep) {
            var r = ProgressStore.get(ep.path), isCur = ep.path === curPath;
            var c = card16({
                size: 'md', key: ep.path,
                cls: (isCur ? 'is-current' : '') + (r && r.done ? ' is-done' : ''),
                art: ThumbsFolder.get(ep.name), bg: toneOf(t.name),
                big: t.kind !== 'colecao' && ep.e != null ? pad2(ep.e) : '',
                check: !!(r && r.done), pct: epPct(ep),
                title: Library.epTitle(t, ep), sub: epSub(t, ep, isCur), subCls: isCur ? 'is-red' : '',
                onClick: function () { openVideoByPath(ep.path, savedPos(ep.path)); },
                onHold: function () { epOptions(t, ep); }
            });
            if (isCur || (!focusCard && p.next && ep.path === p.next.path)) { focusCard = c; }
            el.rail.appendChild(c);
        });
        // fileira ja aberta no episodio atual (sem tirar o foco do botao)
        if (focusCard) { setTimeout(function () { scrollRail(focusCard); }, 0); }
        return focusCard;
    }

    function chooseSeason(t) {
        var seasons = seasonsList(t);
        Options.open({
            title: Library.displayName(t), sub: 'Escolha a temporada',
            art: Meta.backdrop(t.key), pct: null,
            actions: seasons.map(function (s) {
                var done = allDone(s.eps);
                return {
                    icon: s.num === cur.season ? 'check' : null,
                    label: seasonLabel(s) + ' · ' + s.eps.length + ' episódios' + (done ? ' · vista' : ''),
                    run: function () {
                        cur.season = s.num;
                        renderInfo(t);              // o botao de marcar segue a temporada
                        renderEps(t);
                        Nav.focusFirst('season');
                    }
                };
            })
        });
    }

    function render() {
        var t = Library.get(cur.key);
        if (!t) {
            el.title.textContent = cur.key ? cur.key.split('/').pop() : '';
            el.kicker.textContent = 'LENDO O HD…';
            el.text.textContent = ''; el.chips.innerHTML = ''; el.eps.hidden = true;
            return null;
        }
        if (cur.season == null) {
            var p = Library.progressOf(t), ep = p.current || p.next || Library.episodes(t)[0];
            cur.season = ep ? (t.kind === 'colecao' ? 0 : ep.s) : 0;
        }
        renderInfo(t);
        return renderEps(t);
    }

    /* ---------- foco ---------- */

    function remember() {
        var a = document.activeElement;
        saved.group = Nav.getGroup();
        saved.key = a && a.getAttribute ? a.getAttribute('data-key') : null;
    }
    function restore() {
        if (saved.group === 'series-eps' && refocusKey('series-eps', saved.key)) { return; }
        if (saved.group && Nav.restore(saved.group)) { return; }
        Nav.focusFirst('series-actions');
    }
    function refresh() {
        if (Screens.current() !== 'series' || Options.isOpen()) { return; }
        remember();
        render();
        restore();
    }

    function back() { if (!Screens.back()) { Screens.reset('home'); } }

    el.seasonBtn.onclick = function () { var t = Library.get(cur.key); if (t) { chooseSeason(t); } };

    Nav.define('series-actions', { type: 'row',
        down: function () { return !el.eps.hidden ? (!el.seasonBtn.hidden ? 'season' : 'series-eps') : null; } });
    Nav.define('season', { type: 'row', up: 'series-actions', down: 'series-eps' });
    Nav.define('series-eps', { type: 'rail', enter: 'remember',
        up: function () { return !el.seasonBtn.hidden ? 'season' : 'series-actions'; },
        scroll: function (item) { scrollRail(item); } });

    Screens.register('series', {
        el: el.screen,
        enter: function (params, isBack) {
            if (!isBack || params.key !== cur.key) {
                if (params.key !== cur.key) { saved = { group: null, key: null }; }
                cur.key = params.key;
                cur.season = null;
                render();
                Nav.focusFirst('series-actions');
            } else {
                render();
                restore();
            }
        },
        leave: function () { remember(); Art.release(el.rail); },
        refresh: refresh,
        onKey: function (code) { return screenKeys(code, back); }
    });

    return { refresh: refresh };
})();
