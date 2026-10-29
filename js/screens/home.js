/* ============================================================================
 * AmorecoFlix - js/screens/home.js
 * Inicio (tela 1 do prototipo): destaque FIXO com o que voce esta vendo
 * (decisao D6), fileira "Continuar assistindo" e "Proximos episodios".
 * Segurar OK num card abre as Opcoes (tela 5).
 * ==========================================================================*/

var Home = (function () {

    function $(id) { return document.getElementById(id); }
    var el = {
        screen: $('screen-home'), scroll: $('home-scroll'), img: $('hero-img'),
        kicker: $('hero-kicker'), title: $('hero-title'), text: $('hero-text'),
        prog: $('hero-prog'), progText: $('hero-prog-text'), progFill: $('hero-prog-fill'),
        play: $('hero-play'), info: $('hero-info'),
        rowCont: $('row-continue'), railCont: $('rail-continue'),
        rowNext: $('row-nextup'), railNext: $('rail-nextup')
    };
    var saved = { group: null, key: null };     // foco ao voltar para o Inicio

    /* ---------- dados ---------- */

    function epOfPath(t, path) {
        if (!t) { return null; }
        return Library.episodes(t).filter(function (e) { return e.path === path; })[0] || null;
    }
    /* nome do titulo de um arquivo (com ou sem a Library pronta) */
    function nameOf(t, path) {
        return t ? Library.displayName(t) : (UI.seriesNameFromPath(path) || UI.cleanName(baseName(path)));
    }
    function codeOf(ep, path) { return ep ? Library.epCode(ep) : (UI.epLabel(baseName(path)) || ''); }
    function left(rec) {
        return UI.validDur(rec.duration) ? fmtMinutes(rec.duration - rec.position) + ' restantes' : 'continuar';
    }
    function pctOf(rec) { return UI.validDur(rec.duration) ? rec.position / rec.duration * 100 : 0; }
    function stillOf(t, path) { return ThumbsFolder.get(baseName(path)) || (t ? Meta.backdrop(t.key) : null); }

    function continueItems() {
        var all = ProgressStore.continueList().filter(function (r) { return !isJunkVideo(baseName(r.path)); });
        var list = UI.dedupeContinueBySeries(all).slice(0, 12);
        return list.map(function (r) {
            var t = Library.ofPath(r.path);
            return { rec: r, path: r.path, t: t, ep: epOfPath(t, r.path) };
        });
    }

    /* destaque: o que esta vendo; senao o proximo episodio; senao algo novo */
    function pickHero(cont, next) {
        if (cont.length) { return { mode: 'continue', t: cont[0].t, ep: cont[0].ep, path: cont[0].path, rec: cont[0].rec }; }
        if (next.length) { return { mode: 'next', t: next[0].title, ep: next[0].ep, path: next[0].ep.path }; }
        var all = Library.all().slice().sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
        for (var i = 0; i < all.length; i++) {
            var p = Library.progressOf(all[i]);
            if (!p.watched && p.next) { return { mode: 'new', t: all[i], ep: p.next, path: p.next.path }; }
        }
        if (all.length) {
            var p0 = Library.progressOf(all[0]);
            if (p0.next) { return { mode: 'new', t: all[0], ep: p0.next, path: p0.next.path }; }
        }
        return null;
    }

    function kickerOf(t) {
        if (!t) { return ''; }
        var m = Meta.title(t.key), parts = [kindLabel(t).toUpperCase()];
        if (m && m.ano) { parts.push(m.ano); }
        if (t.kind === 'filme') {
            var d = Library.epDuration(t, Library.episodes(t)[0]);
            if (d) { parts.push(fmtMinutes(d).toUpperCase()); }
        } else if (t.kind === 'colecao') {
            parts.push(Library.episodes(t).length + ' FILMES');
        } else {
            var ns = Library.seasonsOf(t).length, ne = Library.episodes(t).length;
            parts.push(ns > 1 ? ns + ' TEMPORADAS' : ne + (ne === 1 ? ' EPISÓDIO' : ' EPISÓDIOS'));
        }
        return parts.join(' · ');
    }

    /* ---------- desenho ---------- */

    function renderHero(hero) {
        var empty = !hero;
        el.screen.classList.toggle('is-empty', empty);
        if (empty) {
            el.kicker.textContent = Library.scanned() ? 'BIBLIOTECA VAZIA' : 'LENDO O HD…';
            el.title.textContent = 'AmorecoFlix';
            sizeHeroTitle(el.title, 'AmorecoFlix');
            el.text.textContent = Library.scanned()
                ? 'Nenhum vídeo na pasta AmorecoFlix ainda. Use o Importador no PC ou abra as Pastas.'
                : 'Os seus títulos aparecem aqui em instantes.';
            el.prog.hidden = true;
            el.play.innerHTML = Icons.svg('folder', 28) + 'Abrir Pastas';
            el.play.onclick = function () { Topbar.open('folders'); };
            el.info.hidden = true;
            Art.set(el.img, null);
            return;
        }
        var t = hero.t, name = nameOf(t, hero.path), m = t ? Meta.title(t.key) : null;
        Art.set(el.img, (t && Meta.backdrop(t.key)) || ThumbsFolder.get(baseName(hero.path)), true);
        el.kicker.textContent = kickerOf(t);
        el.title.textContent = name;
        sizeHeroTitle(el.title, name);
        el.text.textContent = (m && m.sinopse) || '';
        el.text.hidden = !el.text.textContent;

        var code = codeOf(hero.ep, hero.path), isFilm = !t || t.kind === 'filme' || !code;
        if (hero.mode === 'continue') {
            el.prog.hidden = false;
            el.progText.textContent = (isFilm ? 'Parou em ' + fmtTime(hero.rec.position) : code) + ' · ' + left(hero.rec);
            el.progFill.style.width = pctOf(hero.rec) + '%';
            el.play.innerHTML = Icons.svg('play', 28) + (isFilm ? 'Continuar' : 'Continuar ' + code.replace(/^T\d+ /, ''));
            el.play.onclick = function () { openVideoByPath(hero.path, hero.rec.position); };
        } else {
            el.prog.hidden = hero.mode !== 'next';
            el.progText.textContent = hero.mode === 'next' ? 'Próximo: ' + code + (t ? ' · ' + Library.epTitle(t, hero.ep) : '') : '';
            el.progFill.style.width = '0%';
            el.play.innerHTML = Icons.svg('play', 28) + (isFilm ? 'Assistir' : 'Assistir ' + code.replace(/^T\d+ /, ''));
            el.play.onclick = function () { openVideoByPath(hero.path, savedPos(hero.path)); };
        }
        el.info.hidden = !t;
        el.info.innerHTML = Icons.svg('info', 26) + (t && t.kind !== 'filme' ? (t.kind === 'colecao' ? 'Filmes e detalhes' : 'Episódios e detalhes') : 'Detalhes');
        el.info.onclick = function () { if (t) { Screens.go('series', { key: t.key }); } };
    }

    function continueOptions(it) {
        var t = it.t, r = it.rec, name = nameOf(t, it.path), code = codeOf(it.ep, it.path);
        var film = !t || t.kind === 'filme' || !code;
        Options.open({
            title: name,
            sub: (code ? code + ' · ' : '') + 'parou em ' + fmtTime(r.position) + ' · ' + left(r),
            art: stillOf(t, it.path), pct: pctOf(r),
            actions: [
                { icon: 'play', label: 'Continuar de ' + fmtTime(r.position), run: function () { openVideoByPath(it.path, r.position); } },
                { icon: 'restart', label: film ? 'Começar do início' : 'Começar o episódio do início', run: function () { openVideoByPath(it.path, 0); } },
                t && t.kind !== 'filme' ? { icon: 'episodes', label: t.kind === 'colecao' ? 'Ver filmes' : 'Ver episódios', run: function () { Screens.go('series', { key: t.key }); } } : null,
                { icon: 'check', label: 'Marcar como assistido', run: function () { ProgressStore.setDone(it.path, true); refresh(); } },
                { icon: 'close', label: 'Tirar de Continuar assistindo', danger: true, run: function () { ProgressStore.hide(it.path); refresh(); } }
            ]
        });
    }

    function nextOptions(x) {
        var t = x.title, ep = x.ep;
        Options.open({
            title: Library.displayName(t), sub: Library.epCode(ep) + ' · ' + Library.epTitle(t, ep),
            art: stillOf(t, ep.path), pct: null,
            actions: [
                { icon: 'play', label: 'Assistir ' + Library.epCode(ep), run: function () { openVideoByPath(ep.path, 0); } },
                { icon: 'episodes', label: 'Ver episódios', run: function () { Screens.go('series', { key: t.key }); } },
                { icon: 'check', label: 'Marcar como assistido', run: function () { ProgressStore.setDone(ep.path, true); refresh(); } }
            ]
        });
    }

    function renderRails(cont, next) {
        el.railCont.innerHTML = '';
        el.railCont.style.transform = '';
        cont.forEach(function (it) {
            el.railCont.appendChild(card16({
                size: 'lg', key: it.path, cls: 'has-hold',
                art: stillOf(it.t, it.path), over: nameOf(it.t, it.path),
                badge: codeOf(it.ep, it.path) || 'FILME', pct: pctOf(it.rec), sub: left(it.rec),
                onClick: function () { openVideoByPath(it.path, it.rec.position); },
                onHold: function () { continueOptions(it); }
            }));
        });
        el.rowCont.hidden = !cont.length;

        el.railNext.innerHTML = '';
        el.railNext.style.transform = '';
        next.forEach(function (x) {
            var et = Library.epTitle(x.title, x.ep);
            el.railNext.appendChild(card16({
                size: 'lg', key: x.ep.path, cls: 'has-hold',
                art: stillOf(x.title, x.ep.path), over: Library.displayName(x.title),
                badge: Library.epCode(x.ep), sub: /^Episódio \d+$/.test(et) ? 'Novo episódio' : et,
                onClick: function () { openVideoByPath(x.ep.path, 0); },
                onHold: function () { nextOptions(x); }
            }));
        });
        el.rowNext.hidden = !next.length;
    }

    function render() {
        var cont = continueItems(), next = Library.nextUp(12);
        renderHero(pickHero(cont, next));
        renderRails(cont, next);
    }

    /* ---------- foco e rolagem ---------- */

    function remember() {
        var a = document.activeElement;
        saved.group = Nav.getGroup();
        saved.key = a && a.getAttribute ? a.getAttribute('data-key') : null;
    }
    function restore() {
        var g = saved.group;
        if ((g === 'continue' || g === 'nextup') && refocusKey(g, saved.key)) { return; }
        if (g === 'tabs') { Topbar.focusTabs(); return; }
        if (g && g !== 'hero' && Nav.restore(g)) { return; }
        Nav.focusFirst('hero');
    }

    /* foco na 2a fileira: a tela sobe para mostra-la inteira */
    function scrollFor(group) {
        var y = 0;
        if (group === 'nextup' && !el.rowCont.hidden) { y = el.rowNext.offsetTop - el.rowCont.offsetTop; }
        el.scroll.style.transform = y ? 'translateY(' + (-y) + 'px)' : '';
        el.screen.classList.toggle('scrolled', !!y);
    }

    function refresh() {
        if (Screens.current() !== 'home' || Options.isOpen()) { return; }
        remember();
        render();
        restore();
    }

    /* RETURN: dos cards volta para o destaque; do destaque, para as abas */
    function back() {
        var g = Nav.getGroup();
        if (g === 'continue' || g === 'nextup') { Nav.focusFirst('hero'); }
        else if (g === 'hero') { Topbar.focusTabs(); }
    }

    Nav.define('hero', { type: 'row', up: 'tabs',
        down: function () { return !el.rowCont.hidden ? 'continue' : 'nextup'; },
        scroll: function () { scrollFor('hero'); } });
    Nav.define('continue', { type: 'rail', up: 'hero', down: 'nextup',
        scroll: function (item) { scrollFor('continue'); railScroller(el.railCont)(item); } });
    Nav.define('nextup', { type: 'rail', up: function () { return !el.rowCont.hidden ? 'continue' : 'hero'; },
        scroll: function (item) { scrollFor('nextup'); railScroller(el.railNext)(item); } });

    Screens.register('home', {
        el: el.screen,
        enter: function (params, isBack) {
            render();
            if (params.fromTabs) { Topbar.focusTabs(); }
            else if (isBack) { restore(); }
            else { Nav.focusFirst('hero'); }
        },
        leave: function () { remember(); },
        refresh: refresh,
        onKey: function (code) { return screenKeys(code, back); }
    });

    return { refresh: refresh };
})();
