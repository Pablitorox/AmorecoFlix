/* ============================================================================
 * AmorecoFlix - js/screens/common.js
 * Pecas comuns das telas: barra do topo (abas + status do HD), dialogo de
 * Opcoes (segurar OK), tela "Conecte o HD" e as teclas padrao das telas.
 * ==========================================================================*/

/* ponto salvo de um arquivo (0 se nunca abriu ou ja foi assistido) */
function savedPos(path) {
    var r = ProgressStore.get(path);
    return (r && !r.done) ? (r.position || 0) : 0;
}

/* teclas padrao de uma tela de navegacao (Inicio, Biblioteca, Pastas, serie) */
function screenKeys(code, onBack) {
    switch (code) {
        case KEY.LEFT:  Nav.move('left');  break;
        case KEY.RIGHT: Nav.move('right'); break;
        case KEY.UP:    Nav.move('up');    break;
        case KEY.DOWN:  Nav.move('down');  break;
        case KEY.ENTER: Nav.okDown();      break;     // segurar OK = Opcoes (data-hold)
        case KEY.STOP:
        case KEY.RETURN: if (onBack) { onBack(); } break;
        case KEY.RED:   scanUsb(); break;
        case KEY.BLUE:  NetUpload.toggleStatus(); break;
    }
    return true;
}

/* rotulo do tipo de titulo */
function kindLabel(t) {
    return { serie: 'Série', anime: 'Anime', filme: 'Filme', colecao: 'Coleção' }[t && t.kind] || '';
}


/* ---------------- barra do topo ---------------- */
var Topbar = (function () {
    var bar = document.getElementById('topbar');
    var hd  = document.getElementById('hd-status');
    var tabs = Array.prototype.slice.call(bar.querySelectorAll('.tab'));
    var WITH_BAR = { home: 1, catalog: 1, folders: 1, nohd: 1 };
    var DOWN = { home: 'hero', catalog: 'chips', folders: 'files' };

    function setHd(text, cls) {
        hd.className = 'hd-status' + (cls ? ' ' + cls : '');
        hd.innerHTML = (cls === 'ok' || cls === 'error' ? Icons.svg('hd', 24) : '') + '<span>' + escapeHtml(text) + '</span>';
    }

    /* troca de aba: as abas sao "irmas" (nao empilham) - RETURN volta ao Inicio */
    function open(name) {
        if (Screens.current() === name) { return; }
        Screens.go(name, { fromTabs: true }, { replace: true });
    }

    function focusTabs() {
        var cur = Screens.current(), list = Nav.items('tabs');
        for (var i = 0; i < list.length; i++) {
            if (list[i].getAttribute('data-screen') === cur) { Nav.focusIndex('tabs', i); return; }
        }
        Nav.focusFirst('tabs');
    }

    Screens.onShow(function (name) {
        bar.hidden = !WITH_BAR[name];
        bar.classList.toggle('no-tabs', name === 'nohd');
        bar.classList.toggle('solid', name === 'catalog' || name === 'folders');   // grade rola por baixo
        tabs.forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-screen') === name); });
    });
    tabs.forEach(function (t) {
        t.addEventListener('click', function () { open(t.getAttribute('data-screen')); });
    });
    Nav.define('tabs', { type: 'row', down: function () { return DOWN[Screens.current()]; } });

    return { setHd: setHd, open: open, focusTabs: focusTabs };
})();


/* ---------------- Opcoes (segurar OK num card) ----------------
 * Options.open({ title, sub, art, pct, actions: [{ label, icon, danger, run }] }) */
var Options = (function () {
    var box   = document.getElementById('options');
    var list  = document.getElementById('options-list');
    var img   = document.getElementById('options-img');
    var fill  = document.getElementById('options-fill');
    var title = document.getElementById('options-title');
    var sub   = document.getElementById('options-sub');
    var back  = null;            // { el, group } p/ devolver o foco
    var openedAt = 0;            // OK repetido logo apos abrir nao escolhe nada

    function open(o) {
        back = { el: document.activeElement, group: Nav.getGroup() };
        title.textContent = o.title || '';
        sub.textContent = o.sub || '';
        img.parentNode.style.background = toneOf(o.title);
        Art.set(img, o.art, true);
        fill.parentNode.style.display = o.pct != null ? '' : 'none';
        fill.style.width = (o.pct || 0) + '%';
        list.innerHTML = '';
        o.actions.filter(Boolean).forEach(function (a) {
            var b = h('button', 'opt focusable' + (a.danger ? ' opt-danger' : ''),
                      (a.icon ? Icons.svg(a.icon, 26) : '<i class="opt-noic"></i>') + '<span>' + escapeHtml(a.label) + '</span>');
            b.onclick = function () { close(); a.run(); };
            list.appendChild(b);
        });
        box.hidden = false;
        openedAt = Date.now();
        Layers.open('options');
        Nav.focusFirst('options');
    }

    function close() {
        if (box.hidden) { return; }
        box.hidden = true;
        Layers.close('options', true);
        if (back && back.el && document.body.contains(back.el)) {
            Nav.setGroup(back.group);
            try { back.el.focus({ preventScroll: true }); } catch (e) { back.el.focus(); }
        }
        back = null;
    }

    Nav.define('options', { type: 'col' });
    Layers.register('options', { onKey: function (code) {
        switch (code) {
            case KEY.UP:    Nav.move('up');   break;
            case KEY.DOWN:  Nav.move('down'); break;
            case KEY.ENTER: if (Date.now() - openedAt > 400) { Nav.activate(); } break;
            case KEY.STOP:
            case KEY.RETURN: close(); break;
        }
    } });

    return { open: open, close: close, isOpen: function () { return !box.hidden; } };
})();


/* ---------------- Conecte o HD ---------------- */
var NoHD = (function () {
    var scr = document.getElementById('screen-nohd');
    var TEXT = {
        hd:    { t: 'Conecte o HD',
                 p: 'O AmorecoFlix procura a pasta <b>AmorecoFlix</b> no HD USB. Conecte o HD em qualquer porta da TV — a biblioteca aparece sozinha, com o seu progresso.' },
        pasta: { t: 'Falta a pasta AmorecoFlix',
                 p: 'O HD foi encontrado, mas não tem a pasta <b>AmorecoFlix</b> na raiz. Crie a pasta no PC (ou use o Importador) e procure de novo.' }
    };

    function fill(reason) {
        var x = TEXT[reason] || TEXT.hd;
        document.getElementById('nohd-title').textContent = x.t;
        document.getElementById('nohd-text').innerHTML = x.p;
    }

    var pending = false;          // o HD saiu durante um video: a tela aparece ao sair do player

    function show(reason) {
        fill(reason);
        if (isPlayerActive()) { pending = true; UI.toast('O HD foi desconectado.'); return; }
        if (Screens.current() !== 'nohd') { Screens.reset('nohd', { reason: reason }); }
    }
    function hide() {
        pending = false;
        if (Screens.current() === 'nohd') { Screens.reset('home'); }
    }

    /* saindo do player: sem o HD, vai para "Conecte o HD" em vez de voltar
       para uma tela com a biblioteca antiga (true = ja abriu) */
    function afterPlayer() {
        if (!pending) { return false; }
        pending = false;
        Screens.reset('nohd');
        return true;
    }

    document.getElementById('nohd-ic').innerHTML = Icons.svg('hd', 72, 1.6);
    document.getElementById('nohd-retry').onclick = function () { scanUsb(); };
    Nav.define('nohd', { type: 'row' });
    Screens.register('nohd', {
        el: scr,
        enter: function () { Nav.focusFirst('nohd'); },
        onKey: function (code) { return screenKeys(code); }
    });

    return { show: show, hide: hide, afterPlayer: afterPlayer };
})();


/* biblioteca/metadados mudaram (HD lido, json chegou): a tela atual se redesenha */
Library.onChange(function (why) { Screens.refresh(why); });
