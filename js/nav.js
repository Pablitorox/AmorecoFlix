/* ============================================================================
 * AmorecoFlix - js/nav.js
 * Foco por controle remoto (D-pad). Cada tela declara seus GRUPOS de foco:
 *
 *   Nav.define('continue', { type: 'rail', up: 'hero', down: 'nextup' });
 *
 *   type   'row'  botoes lado a lado (esq/dir)
 *          'rail' fileira que rola na horizontal (esq/dir, centraliza o foco)
 *          'col'  lista vertical (cima/baixo)
 *          'grid' grade (colunas descobertas pela posicao dos itens)
 *   up/down/left/right  grupo vizinho ao sair pela borda (ou funcao que o devolve)
 *   enter  'remember' (padrao: volta no ultimo item focado do grupo) ou
 *          'nearest' (item mais proximo na horizontal de onde veio o foco)
 *   items  function () -> [elementos]  (padrao: .focusable/.card dentro de
 *          [data-nav-group="<id>"])
 *   scroll function (el, idx, list)    (padrao: scrollIntoView)
 *
 * Segurar OK: elemento com o atributo data-hold e uma funcao el._onHold
 * dispara depois de 550 ms; toque curto = click() normal.
 * ==========================================================================*/

var Nav = (function () {

    var groups = {};          // id -> configuracao
    var group  = 'files';     // grupo ativo
    var last   = {};          // id -> ultimo indice focado
    var lastMoveAt = 0;
    var MOVE_GAP = 70;        // tecla segurada: no maximo 1 movimento a cada 70 ms na mesma direcao

    function define(id, cfg) { groups[id] = cfg || {}; }
    function cfgOf(g) { return groups[g] || {}; }

    /* visivel = ocupa espaco na tela (funciona tambem p/ position:fixed) */
    function shown(e) { return !!(e && e.getClientRects().length); }

    function items(g) {
        var c = cfgOf(g), out = [];
        if (c.items) { out = c.items() || []; }
        else {
            var conts = document.querySelectorAll('[data-nav-group="' + g + '"]');
            Array.prototype.forEach.call(conts, function (cont) {
                if (cont.classList.contains('focusable')) { out.push(cont); return; }
                out = out.concat(Array.prototype.slice.call(cont.querySelectorAll('.focusable, .card')));
            });
        }
        return out.filter(shown);
    }

    function focusAt(g, list, idx) {
        var el = list[idx];
        if (!el) { return; }
        group = g;
        last[g] = idx;
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        var c = cfgOf(g);
        if (c.scroll) { c.scroll(el, idx, list); }
        else if (el.scrollIntoView) {
            el.scrollIntoView({ block: 'nearest', inline: c.type === 'rail' ? 'center' : 'nearest' });
        }
    }

    function focusFirst(g) {
        group = g;
        var list = items(g);
        if (list.length) { focusAt(g, list, 0); }
    }

    /* volta no ultimo item focado do grupo (ou no primeiro) */
    function restore(g) {
        group = g;
        var list = items(g);
        if (!list.length) { return false; }
        focusAt(g, list, Math.min(last[g] || 0, list.length - 1));
        return true;
    }

    function focusIndex(g, idx) {
        var list = items(g);
        if (list.length) { focusAt(g, list, Math.max(0, Math.min(idx, list.length - 1))); }
    }

    /* nro de colunas de uma grade (itens que compartilham o topo do 1o) */
    function gridCols(list) {
        if (list.length < 2) { return 1; }
        var top0 = list[0].offsetTop, c = 1;
        for (var i = 1; i < list.length; i++) {
            if (Math.abs(list[i].offsetTop - top0) < 4) { c++; } else { break; }
        }
        return c;
    }

    function centerX(el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; }

    /* item de 'list' mais proximo na horizontal de 'from'. Numa grade, so
       olha a linha por onde o foco entra (1a se veio de cima, ultima se de baixo) */
    function nearest(list, from, dir, isGrid) {
        var cand = list;
        if (isGrid && list.length) {
            var tops = list.map(function (e) { return e.offsetTop; });
            var edge = (dir === 'up') ? Math.max.apply(null, tops) : Math.min.apply(null, tops);
            cand = list.filter(function (e) { return Math.abs(e.offsetTop - edge) < 4; });
        }
        var x = centerX(from), best = 0, bestD = Infinity;
        cand.forEach(function (e) {
            var d = Math.abs(centerX(e) - x);
            if (d < bestD) { bestD = d; best = list.indexOf(e); }
        });
        return best;
    }

    function switchTo(g, fromEl, dir) {
        var list = items(g);
        if (!list.length) { return false; }
        var c = cfgOf(g), idx;
        if (c.enter === 'nearest' && fromEl) { idx = nearest(list, fromEl, dir, c.type === 'grid'); }
        else { idx = Math.min(last[g] || 0, list.length - 1); }
        focusAt(g, list, idx);
        return true;
    }

    var lastDir = '';
    function move(dir) {
        var now = Date.now();
        if (dir === lastDir && now - lastMoveAt < MOVE_GAP) { return; }   // tecla segurada
        lastMoveAt = now;
        lastDir = dir;

        var list = items(group);
        var c = cfgOf(group);
        var idx = list.indexOf(document.activeElement);
        if (!list.length || idx === -1) {
            if (list.length) { focusAt(group, list, Math.min(last[group] || 0, list.length - 1)); }
            else if (c[dir]) { switchTo(typeof c[dir] === 'function' ? c[dir]() : c[dir], null, dir); }
            return;
        }

        var type = c.type || 'row', next = -1;
        if (type === 'grid') {
            var cols = gridCols(list), row = Math.floor(idx / cols), lastRow = Math.floor((list.length - 1) / cols);
            if (dir === 'left'  && idx % cols !== 0)        { next = idx - 1; }
            if (dir === 'right' && idx % cols !== cols - 1) { next = idx + 1; }
            if (dir === 'up'    && row > 0)                 { next = idx - cols; }
            if (dir === 'down'  && row < lastRow)           { next = Math.min(idx + cols, list.length - 1); }
        } else if (type === 'col') {
            if (dir === 'up')   { next = idx - 1; }
            if (dir === 'down') { next = idx + 1; }
        } else {
            if (dir === 'left')  { next = idx - 1; }
            if (dir === 'right') { next = idx + 1; }
        }

        if (next >= 0 && next < list.length) { focusAt(group, list, next); return; }

        var to = c[dir];
        if (typeof to === 'function') { to = to(); }
        if (to && to !== group) { switchTo(to, list[idx], dir); }
    }

    function activate() {
        var cur = document.activeElement;
        if (cur && typeof cur.click === 'function') { cur.click(); }
    }

    /* --- OK: toque = click(); segurar (data-hold) = el._onHold() --- */
    var HOLD_MS = 550;
    var holdTimer = null, holdFired = false, holdEl = null;

    function okDown() {
        var cur = document.activeElement;
        if (cur && cur.hasAttribute && cur.hasAttribute('data-hold')) {
            if (holdTimer === null && !holdFired) {          // keydown repete enquanto segura
                holdEl = cur;
                holdTimer = setTimeout(function () {
                    holdTimer = null;
                    holdFired = true;
                    if (holdEl && holdEl._onHold) { holdEl._onHold(); }
                }, HOLD_MS);
            }
            return;
        }
        activate();
    }

    /* keyup do OK: se nao chegou a segurar, e um toque -> click() */
    function okUp() {
        if (holdTimer === null && !holdFired) { return; }
        var wasLong = holdFired, el = holdEl;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        holdFired = false;
        holdEl = null;
        if (!wasLong && el && el.click) { el.click(); }
    }

    /* OK ainda apertado depois de um toque longo: os keydown repetidos nao
       podem chegar no menu que acabou de abrir (viraria "Assistir") */
    function holding() { return holdTimer !== null || holdFired; }

    function setGroup(g) { group = g; }
    function getGroup()  { return group; }

    return {
        define: define, items: items, focusFirst: focusFirst, restore: restore, focusIndex: focusIndex,
        move: move, activate: activate, okDown: okDown, okUp: okUp, holding: holding,
        setGroup: setGroup, getGroup: getGroup
    };
})();
