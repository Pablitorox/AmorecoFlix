/* ============================================================================
 * AmorecoFlix - js/router.js
 * Screens: telas inteiras (uma ativa por vez) com pilha de navegacao -
 *          RETURN volta para a anterior, com o foco onde estava.
 * Layers:  camadas por cima da tela (dialogo, painel). A do topo recebe as
 *          teclas antes da tela.
 *
 *   Screens.register('series', {
 *       el:    elemento da tela (ganha a classe 'active'),
 *       enter: function (params, isBack) {},   // montar / restaurar o foco
 *       leave: function () {},                 // liberar imagens grandes etc.
 *       onKey: function (code, ev) {}          // teclas da tela
 *   });
 *   Screens.go('series', { title: 'Animes/Death Parade' });
 *   Screens.back();                            // false = ja esta na raiz
 *
 *   Layers.register('options', { onKey: fn, onClose: fn });
 *   Layers.open('options'); Layers.close('options');
 * ==========================================================================*/

var Screens = (function () {

    var defs = {}, stack = [], cur = null, curParams = null, showListeners = [];

    function register(name, def) { defs[name] = def; }
    function onShow(fn) { showListeners.push(fn); }

    /* algo mudou (HD lido de novo, progresso, metadados): a tela atual se
       redesenha, se souber (def.refresh), mantendo o foco */
    function refresh(why) {
        var d = cur && defs[cur];
        if (d && d.refresh) {
            try { d.refresh(why); } catch (e) { console.error('[screens] refresh ' + cur + ':', e && e.message); }
        }
    }

    function show(name, params, isBack) {
        var def = defs[name];
        if (!def) { console.warn('[screens] tela desconhecida:', name); return; }
        if (cur && cur !== name && defs[cur].leave) { defs[cur].leave(); }
        for (var n in defs) {
            if (defs.hasOwnProperty(n) && defs[n].el) { defs[n].el.classList.toggle('active', n === name); }
        }
        cur = name;
        curParams = params || {};
        showListeners.forEach(function (fn) { fn(name); });
        if (def.enter) { def.enter(curParams, !!isBack); }
    }

    /* abre uma tela; a atual vai para a pilha (exceto opts.replace ou mesma tela) */
    function go(name, params, opts) {
        if (cur && cur !== name && !(opts && opts.replace)) {
            stack.push({ name: cur, params: curParams });
        }
        show(name, params, false);
    }

    function back() {
        if (!stack.length) { return false; }
        var p = stack.pop();
        show(p.name, p.params, true);
        return true;
    }

    /* volta ate a tela 'name' (ou abre ela como raiz, se nao estiver na pilha) */
    function backTo(name) {
        while (stack.length) {
            var p = stack.pop();
            if (p.name === name) { show(name, p.params, true); return; }
        }
        show(name, {}, true);
    }

    /* abre 'name' como raiz (esvazia a pilha): HD saiu/voltou, etc. */
    function reset(name, params) {
        stack = [];
        show(name, params || {}, false);
    }

    function onKey(code, ev) {
        var d = cur && defs[cur];
        return !!(d && d.onKey && d.onKey(code, ev));
    }

    return {
        register: register, go: go, back: back, backTo: backTo, reset: reset, onKey: onKey,
        refresh: refresh, onShow: onShow,
        current: function () { return cur; },
        params: function () { return curParams; },
        depth: function () { return stack.length; }
    };
})();


var Layers = (function () {

    var defs = {}, open_ = [];

    function register(name, def) { defs[name] = def || {}; }

    function open(name) {
        close(name, true);
        open_.push(name);
    }

    /* silent = so tira da pilha, sem chamar onClose */
    function close(name, silent) {
        var i = open_.indexOf(name);
        if (i === -1) { return; }
        open_.splice(i, 1);
        if (!silent && defs[name] && defs[name].onClose) { defs[name].onClose(); }
    }

    function top() { return open_.length ? open_[open_.length - 1] : null; }

    /* teclas vao para a camada do topo; true = tratou (a tela nao recebe) */
    function onKey(code, ev) {
        var t = top();
        if (!t) { return false; }
        var d = defs[t];
        return d && d.onKey ? d.onKey(code, ev) !== false : true;
    }

    return {
        register: register, open: open, close: close, top: top, onKey: onKey,
        isOpen: function (name) { return open_.indexOf(name) !== -1; }
    };
})();
