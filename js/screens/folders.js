/* ============================================================================
 * AmorecoFlix - js/screens/folders.js
 * Pastas (tela 4 do prototipo): a navegacao pelas pastas do HD de sempre
 * (enterDirectory / goUpDirectory no app.js), com o visual novo - cards
 * 16:9, faixa "Na TEMPORADA", ✓ em pasta toda vista e barra de teclas.
 * Continua sendo o "modo avancado": tudo que esta no HD aparece aqui.
 * ==========================================================================*/

var Folders = (function () {

    function $(id) { return document.getElementById(id); }
    var el = { screen: $('screen-folders'), crumb: $('breadcrumb'), scroll: $('fl-scroll'), list: $('file-list') };
    // rola a GRADE dentro da janela fixa (fl-scroll recorta) - rolar a janela
    // fazia os cards subirem por cima da barra do topo e do caminho
    var scrollGrid = vScroller(el.list, 760, 24);

    /* ---------- dados de uma pasta ---------- */

    function epsUnder(path) {
        var out = [];
        Library.all().forEach(function (t) {
            t.seasons.forEach(function (s) {
                s.eps.forEach(function (e) { if (e.path.indexOf(path + '/') === 0) { out.push(e); } });
            });
        });
        return out;
    }
    function doneCount(eps) {
        var n = 0;
        eps.forEach(function (e) { var r = ProgressStore.get(e.path); if (r && r.done) { n++; } });
        return n;
    }
    function inProgress(eps) {
        var best = null, bestAt = 0;
        eps.forEach(function (e) {
            var r = ProgressStore.get(e.path);
            if (r && !r.done && r.position >= 1000 && (r.updated || 0) > bestAt) { bestAt = r.updated; best = e; }
        });
        return best;
    }

    function dirCard(entry, i) {
        var full = entry.file.fullPath, rel = relPath(full), parts = rel.split('/');
        var o = { size: 'fl', key: full, cls: 'is-dir' };
        if (parts.length === 1) {                                   // Series / Animes / Filmes
            var n = Library.all().filter(function (t) { return t.key.indexOf(rel + '/') === 0; }).length;
            o.over = entry.name;
            o.sub = n ? n + (n === 1 ? ' título' : ' títulos') : '';
        } else {
            var key = parts[0] + '/' + parts[1], t = Library.get(key);
            var eps = epsUnder(full), seen = doneCount(eps), cur = inProgress(eps);
            var art = Meta.backdrop(key);
            o.art = art || ThumbsFolder.get(entry.name);
            if (!art) { o.cls += ' art-contain'; }
            if (parts.length === 2) {                              // pasta do titulo
                o.over = t ? Library.displayName(t) : entry.name;
                var ns = t ? Library.seasonsOf(t).length : 0;
                o.sub = t && t.kind === 'colecao' ? eps.length + ' filmes'
                      : ns > 1 ? ns + ' temporadas' : eps.length + ' episódios';
            } else {                                                // temporada
                var num = seasonNumber(entry.name);
                o.band = num ? num + 'ª TEMPORADA' : entry.name;
                o.sub = eps.length + (eps.length === 1 ? ' episódio' : ' episódios');
            }
            if (eps.length && seen === eps.length) { o.check = true; o.cls += ' is-done'; o.sub += ' · assistida'; }
            else if (cur) { o.sub += ' · em andamento (' + (cur.e != null ? 'E' + cur.e : UI.cleanName(cur.name)) + ')'; }
            else if (seen) { o.sub += ' · ' + seen + ' vistos'; }
        }
        o.onClick = function () { onEntryActivate(i); };
        var c = card16(o);
        if (o.band) {
            var b = h('div', 'fl-band', escapeHtml(o.band));
            c.querySelector('.c16-art').appendChild(b);
        }
        c.setAttribute('data-index', i);
        return c;
    }

    function fileCard(entry, i, dirName_) {
        var path = entry.file.fullPath;
        var rec = ProgressStore.get(path), cx = ContentIndex.get(path), tc = Thumbs.get(path);
        var t = Library.ofPath(path), ep = null;
        if (t) { ep = Library.episodes(t).filter(function (e) { return e.path === path; })[0] || null; }

        var durMs = 0;
        if (tc && UI.validDur(tc.d)) { durMs = tc.d; }
        else if (rec && UI.validDur(rec.duration)) { durMs = rec.duration; }
        else if (cx && UI.validDur(cx.duration)) { durMs = cx.duration; }
        else if (t && ep) { durMs = Library.epDuration(t, ep); }

        var pct = null, sub;
        if (rec && rec.done) { sub = 'Assistido'; pct = 100; }
        else if (rec && rec.position > 3000 && UI.validDur(rec.duration)) {
            pct = rec.position / rec.duration * 100;
            sub = 'Continuar · ' + fmtMinutes(rec.duration - rec.position) + ' restantes';
        } else { sub = durMs ? fmtMinutes(durMs) : (entry.size ? fmtSize(entry.size) : ''); }

        var code = ep ? Library.epCode(ep) : UI.epLabel(entry.name);
        var c = card16({
            size: 'fl', key: path, cls: 'is-file' + (rec && rec.done ? ' is-done' : ''),
            art: ThumbsFolder.get(entry.name) || Thumbs.quick(entry, App.dirImages, dirName_),
            bg: toneOf(entry.name),
            badge: code || (durMs ? fmtTime(durMs) : ''),
            check: !!(rec && rec.done), pct: pct,
            title: ep && t ? Library.epTitle(t, ep) : ((cx && cx.title) || UI.cleanName(entry.name)),
            sub: sub,
            onClick: function () { onEntryActivate(i); }
        });
        c.setAttribute('data-index', i);
        c.setAttribute('data-path', path);
        return c;
    }

    /* ---------- desenho ---------- */

    function renderBreadcrumb() {
        var parts = App.dirStack.concat(App.currentDir ? [App.currentDir] : []);
        el.crumb.innerHTML = parts.map(function (d, i) {
            var last = i === parts.length - 1;
            return '<span class="crumb' + (last ? ' current' : '') + '">' + escapeHtml(d.name || 'HD') + '</span>' +
                   (last ? '' : '<span class="sep" aria-hidden="true">›</span>');
        }).join('');
    }

    function render(entries, focusName) {
        var dirName_ = App.currentDir && App.currentDir.name;
        el.list.innerHTML = '';
        scrollGrid.reset();
        if (!entries.length) {
            el.list.innerHTML = '<li class="fl-empty">' + (App.currentDir ? 'Pasta vazia.' : 'Nenhum HD conectado.') + '</li>';
        }
        var focusIdx = 0;
        entries.forEach(function (e, i) {
            if (focusName && e.name === focusName) { focusIdx = i; }
            el.list.appendChild(e.isDir ? dirCard(e, i) : fileCard(e, i, dirName_));
        });
        if (Screens.current() === 'folders' && !Options.isOpen() && Nav.getGroup() !== 'tabs') {
            Nav.focusIndex('files', focusIdx);
        }
    }

    /* resultado tardio (miniatura / duracao) -> atualiza o card */
    function applyThumb(path, r) {
        if (!r) { return; }
        var card = el.list.querySelector('[data-path="' + String(path).replace(/"/g, '\\"') + '"]');
        if (!card) { return; }
        if (r.u) { Art.set(card.querySelector('img'), r.u); }
        var badge = card.querySelector('.c16-badge');
        if (UI.validDur(r.d) && !badge) {
            var b = h('span', 'c16-badge', fmtTime(r.d));
            card.querySelector('.c16-art').appendChild(b);
        }
    }

    function decorate() {
        Array.prototype.forEach.call(el.list.querySelectorAll('.c16.is-file'), function (card) {
            var cx = ContentIndex.get(card.getAttribute('data-path'));
            if (cx && UI.validDur(cx.duration) && !card.querySelector('.c16-badge')) {
                card.querySelector('.c16-art').appendChild(h('span', 'c16-badge', fmtTime(cx.duration)));
            }
        });
    }

    function refresh() {
        if (Screens.current() !== 'folders' || Options.isOpen()) { return; }
        var a = document.activeElement, key = a && a.getAttribute ? a.getAttribute('data-key') : null;
        var group = Nav.getGroup();
        render(App.dirFiles || []);
        if (group === 'files' && key) { refocusKey('files', key); }
    }

    /* RETURN: sobe uma pasta; na raiz da biblioteca, volta ao Inicio */
    function back() {
        if (Nav.getGroup() === 'tabs' || !goUpDirectory()) { Topbar.open('home'); Topbar.focusTabs(); }
    }

    Nav.define('files', { type: 'grid', up: 'tabs', scroll: function (item) { scrollGrid(item); } });

    Screens.register('folders', {
        el: el.screen,
        enter: function (params, isBack) {
            render(App.dirFiles || []);
            if (params.fromTabs) { Topbar.focusTabs(); }
            else if (!isBack) { Nav.focusFirst('files'); }
            else { Nav.restore('files'); }
        },
        refresh: refresh,
        onKey: function (code) { return screenKeys(code, back); }
    });

    return { render: render, renderBreadcrumb: renderBreadcrumb, applyThumb: applyThumb, decorate: decorate };
})();
