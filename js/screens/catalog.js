/* ============================================================================
 * AmorecoFlix - js/screens/catalog.js
 * Biblioteca (tela 3 do prototipo): grade de posteres 2:3 com filtros
 * Tudo / Series / Animes / Filmes, Em andamento / Nao comecadas e a ordem
 * "Recem-adicionados". O filtro escolhido fica lembrado.
 * ==========================================================================*/

var Catalog = (function () {

    function $(id) { return document.getElementById(id); }
    var el = { screen: $('screen-catalog'), scroll: $('cat-scroll'), grid: $('cat-grid'), empty: $('cat-empty') };
    var chips = Array.prototype.slice.call(el.screen.querySelectorAll('.chip'));
    var sortChip = el.screen.querySelector('.chip-sort');
    var state = PrefStore.get('catalogo') || { kind: 'all', st: '', sort: '' };
    var saved = { group: null, key: null };
    var scrollGrid = vScroller(el.scroll, 960, 40);

    /* serie e anime contam como "Series"/"Animes"; colecao entra em Filmes */
    function kindOk(t) {
        if (state.kind === 'all') { return true; }
        if (state.kind === 'filme') { return t.kind === 'filme' || t.kind === 'colecao'; }
        return t.kind === state.kind;
    }
    function stateOk(p) {
        if (state.st === 'andamento') { return p.lastUpdated > 0 && !p.allDone; }
        if (state.st === 'novas') { return p.lastUpdated === 0; }
        return true;
    }

    function subOf(t, p) {
        var k = kindLabel(t);
        if (t.kind === 'filme') {
            var ep = Library.episodes(t)[0], r = ep ? ProgressStore.get(ep.path) : null;
            if (r && r.done) { return k + ' · assistido'; }
            if (r && r.position > 1000 && UI.validDur(r.duration)) { return k + ' · ' + fmtMinutes(r.duration - r.position) + ' restantes'; }
            var d = ep ? Library.epDuration(t, ep) : 0;
            return d ? k + ' · ' + fmtMinutes(d) : k;
        }
        if (t.kind === 'colecao') { return k + ' · ' + p.total + ' filmes' + (p.watched ? ' · ' + p.watched + ' vistos' : ''); }
        if (!p.lastUpdated) {
            var ns = Library.seasonsOf(t).length;
            return k + ' · ' + (ns > 1 ? ns + ' temporadas' : 'não começado');
        }
        return k + ' · ' + p.watched + ' de ' + p.total + ' vistos';
    }
    function pctOf(t, p) {
        if (t.kind === 'filme') {
            var ep = Library.episodes(t)[0], r = ep ? ProgressStore.get(ep.path) : null;
            if (!r) { return 0; }
            return r.done ? 100 : (UI.validDur(r.duration) ? r.position / r.duration * 100 : 0);
        }
        return p.pct;
    }
    function posterOf(t) {
        return t.kind === 'filme' ? (Meta.poster(t.key) || ThumbsFolder.get(t.name))
                                  : (ThumbsFolder.get(t.name) || Meta.poster(t.key));
    }

    function items() {
        var out = [];
        Library.all().forEach(function (t) {
            if (!kindOk(t)) { return; }
            var p = Library.progressOf(t);
            if (stateOk(p)) { out.push({ t: t, p: p, name: Library.displayName(t) }); }
        });
        out.sort(function (a, b) {
            if (state.sort === 'recent') { return (b.t.added || 0) - (a.t.added || 0); }
            var ia = a.p.lastUpdated && !a.p.allDone, ib = b.p.lastUpdated && !b.p.allDone;
            if (ia !== ib) { return ia ? -1 : 1; }               // em andamento primeiro
            if (ia) { return b.p.lastUpdated - a.p.lastUpdated; }
            return a.name.localeCompare(b.name, 'pt');
        });
        return out;
    }

    function options(x) {
        var t = x.t, p = x.p;
        Options.open({
            title: x.name, sub: subOf(t, p), art: Meta.backdrop(t.key) || posterOf(t), pct: p.total > 1 ? p.pct : null,
            actions: [
                { icon: 'info', label: t.kind === 'filme' ? 'Detalhes' : (t.kind === 'colecao' ? 'Ver filmes' : 'Ver episódios'),
                  run: function () { Screens.go('series', { key: t.key }); } },
                p.next ? { icon: 'play', label: p.current ? 'Continuar' : 'Assistir',
                  run: function () { openVideoByPath(p.next.path, savedPos(p.next.path)); } } : null,
                p.allDone
                    ? { icon: 'close', label: 'Marcar como não assistido', run: function () { Library.episodes(t).forEach(function (e) { ProgressStore.setDone(e.path, false); }); refresh(); } }
                    : { icon: 'check', label: t.kind === 'filme' ? 'Marcar como assistido' : 'Marcar tudo como assistido',
                        run: function () { Library.episodes(t).forEach(function (e) { ProgressStore.setDone(e.path, true); }); refresh(); } }
            ]
        });
    }

    function card(x) {
        var t = x.t, p = x.p;
        var c = h('div', 'poster focusable');
        c.tabIndex = 0;
        c.setAttribute('data-key', t.key);
        c.innerHTML =
            '<div class="poster-art" style="background:' + toneOf(t.name) + '">' +
                '<img class="art-img" alt="">' +
                (p.isNew ? '<span class="poster-new">NOVO EP</span>' : '') +
                '<span class="poster-over">' + escapeHtml(x.name) + '</span>' +
                '<div class="c16-bar"><i style="width:' + pctOf(t, p) + '%"></i></div>' +
            '</div>' +
            '<span class="poster-sub">' + escapeHtml(subOf(t, p)) + '</span>';
        Art.set(c.querySelector('img'), posterOf(t));
        c.addEventListener('click', function () { Screens.go('series', { key: t.key }); });
        c.setAttribute('data-hold', '');
        c._onHold = function () { options(x); };
        return c;
    }

    function renderChips() {
        chips.forEach(function (c) {
            var on = (c.hasAttribute('data-kind') && c.getAttribute('data-kind') === state.kind) ||
                     (c.hasAttribute('data-state') && c.getAttribute('data-state') === state.st) ||
                     (c.hasAttribute('data-sort') && state.sort === 'recent');
            c.classList.toggle('on', on);
        });
        sortChip.innerHTML = Icons.svg('sort', 22) + 'Recém-adicionados';
    }

    function render() {
        renderChips();
        var list = items();
        el.grid.innerHTML = '';
        list.forEach(function (x) { el.grid.appendChild(card(x)); });
        el.empty.hidden = list.length > 0 || !Library.ready();
        el.empty.textContent = Library.ready() ? 'Nenhum título com esses filtros.' : '';
    }

    function setFilter(c) {
        if (c.hasAttribute('data-kind')) { state.kind = c.getAttribute('data-kind'); }
        else if (c.hasAttribute('data-state')) { var s = c.getAttribute('data-state'); state.st = state.st === s ? '' : s; }
        else if (c.hasAttribute('data-sort')) { state.sort = state.sort === 'recent' ? '' : 'recent'; }
        PrefStore.set('catalogo', state);
        render();
        scrollGrid.reset();
    }
    chips.forEach(function (c) { c.addEventListener('click', function () { setFilter(c); }); });

    function remember() {
        var a = document.activeElement;
        saved.group = Nav.getGroup();
        saved.key = a && a.getAttribute ? a.getAttribute('data-key') : null;
    }
    function restore() {
        if (saved.group === 'catalog' && refocusKey('catalog', saved.key)) { return; }
        if (saved.group === 'tabs') { Topbar.focusTabs(); return; }
        if (!Nav.restore('chips')) { Topbar.focusTabs(); }
    }
    function refresh() {
        if (Screens.current() !== 'catalog' || Options.isOpen()) { return; }
        remember();
        render();
        restore();
    }

    /* RETURN: da grade volta aos filtros; dos filtros/abas, ao Inicio */
    function back() {
        var g = Nav.getGroup();
        if (g === 'catalog') { scrollGrid.reset(); Nav.restore('chips'); }
        else { Topbar.open('home'); Topbar.focusTabs(); }
    }

    Nav.define('chips', { type: 'row', up: 'tabs', down: 'catalog', scroll: function () { scrollGrid.reset(); } });
    Nav.define('catalog', { type: 'grid', up: 'chips', enter: 'nearest', scroll: function (item) { scrollGrid(item); } });

    Screens.register('catalog', {
        el: el.screen,
        enter: function (params, isBack) {
            render();
            if (isBack) { restore(); }
            else { scrollGrid.reset(); Topbar.focusTabs(); }
        },
        leave: function () { remember(); Art.release(el.grid); },   // ~50 posteres: libera a memoria
        refresh: refresh,
        onKey: function (code) { return screenKeys(code, back); }
    });

    return { refresh: refresh };
})();
