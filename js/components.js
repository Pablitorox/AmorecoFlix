/* ============================================================================
 * AmorecoFlix - js/components.js
 * Pecas visuais compartilhadas pelas telas: icones SVG, criacao de
 * elementos e imagens com carregamento preguicoso + reserva em cor.
 * ==========================================================================*/

/* Icones do prototipo (viewBox 24). stroke = desenhado com traco. */
var Icons = (function () {
    var STROKE = {
        back:     '<path d="M15 6l-6 6 6 6"/>',
        chevDown: '<path d="M6 9l6 6 6-6"/>',
        episodes: '<path d="M4 6h16M4 12h16M4 18h10"/>',
        tracks:   '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 13h4M13 13h4M7 16h7"/>',
        check:    '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        close:    '<path d="M6 6l12 12M18 6L6 18"/>',
        folder:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        sort:     '<path d="M7 4v16M7 20l-3-3M7 20l3-3M14 6h7M14 12h5M14 18h3"/>',
        info:     '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
        restart:  '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>',
        hd:       '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h.01M11 12h6"/>',
        rew10:    '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>' +
                  '<text x="12" y="15.2" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none">10</text>',
        fwd10:    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>' +
                  '<text x="12" y="15.2" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none">10</text>'
    };
    var FILL = {
        play:  '<path d="M7 4.5v15l12.5-7.5z"/>',
        pause: '<path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/>',
        next:  '<path d="M5 5.5v13l9.5-6.5zM16.5 5.5h2.5v13h-2.5z"/>',
        skip:  '<path d="M4 5.5v13l8-6.5zM12 5.5v13l8-6.5z"/>'
    };

    /* svg('play', 28) -> '<svg ...>...</svg>' */
    function svg(name, size, strokeWidth) {
        var s = size || 24;
        if (FILL[name]) {
            return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                   FILL[name] + '</svg>';
        }
        return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
               (strokeWidth || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
               (STROKE[name] || '') + '</svg>';
    }

    /* so os <path> (p/ um <svg> que ja existe na pagina) */
    function paths(name) { return FILL[name] || STROKE[name] || ''; }

    return { svg: svg, paths: paths };
})();


/* Rolagem de uma fileira por transform (mais leve que scroll na TV):
 * centraliza o item focado sem passar das pontas. A fileira precisa de
 * position:relative (offsetLeft dos itens) e o pai e a "janela" visivel. */
function railScroller(rail) {
    return function (item) {
        // largura util da janela (sem o padding): o ultimo card nao encosta na borda
        var p = rail.parentNode, cs = getComputedStyle(p);
        var view = p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        var max = Math.max(0, rail.scrollWidth - view);
        var x = item.offsetLeft + item.offsetWidth / 2 - view / 2;
        x = Math.max(0, Math.min(max, x));
        rail.style.transform = 'translateX(' + (-x) + 'px)';
    };
}

/* Rolagem vertical por transform de uma grade dentro de uma "janela" de
 * altura viewH: so rola o necessario para o item focado caber inteiro.
 * f(item) rola; f.reset() volta ao topo. */
function vScroller(scrollEl, viewH, margin) {
    var y = 0;
    margin = margin || 0;
    function f(item) {
        var sr = scrollEl.getBoundingClientRect(), ir = item.getBoundingClientRect();
        var top = ir.top - sr.top, bottom = ir.bottom - sr.top;
        if (top - margin < y) { y = Math.max(0, top - margin); }
        else if (bottom + margin > y + viewH) { y = bottom + margin - viewH; }
        scrollEl.style.transform = y ? 'translateY(' + (-y) + 'px)' : '';
    }
    f.reset = function () { y = 0; scrollEl.style.transform = ''; };
    return f;
}

/* 7 -> "07" */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* titulo grande (Inicio, pagina do titulo), ja com o texto: diminui para nomes
 * longos. A folga embaixo (.hero-title, pernas do g/j/p) mostraria o topo da 3a
 * linha num nome que passa de 2 - ai ela sai (.is-cut) */
function sizeHeroTitle(node, name) {
    node.className = 'hero-title' + (name.length > 28 ? ' t-sm' : name.length > 16 ? ' t-md' : '');
    if (node.scrollHeight > node.clientHeight + 1) { node.classList.add('is-cut'); }
}

/* 754000 ms -> "13 min" / "1 h 32 min" */
function fmtMinutes(ms) {
    if (!ms || ms <= 0) { return ''; }
    var m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

/* Card 16:9 (Continuar, Proximos, Episodios, Pastas)
 *   o.size   'lg' 400x225 | 'md' 360x203 | 'fl' 420x236 (pastas)
 *   o.art    url da imagem; o.bg fundo de reserva; o.big numero/rotulo grande
 *            no canto (ex.: "07"); o.over titulo escrito sobre a arte
 *   o.badge  selo no canto direito ("T1 E7"); o.check ✓ de assistido
 *   o.pct    barra de progresso (null = sem barra)
 *   o.title  linha abaixo da arte; o.sub linha menor; o.subCls classe extra
 *   o.onClick / o.onHold (segurar OK) / o.key (data-key p/ refocar) */
function card16(o) {
    var c = h('div', 'c16 c16-' + (o.size || 'lg') + ' focusable' + (o.cls ? ' ' + o.cls : ''));
    c.tabIndex = 0;
    if (o.key) { c.setAttribute('data-key', o.key); }
    c.innerHTML =
        '<div class="c16-art" style="background:' + (o.bg || toneOf(o.over || o.title)) + '">' +
            '<img class="art-img" alt="">' +
            (o.big ? '<span class="c16-big">' + escapeHtml(o.big) + '</span>' : '') +
            (o.badge ? '<span class="c16-badge">' + escapeHtml(o.badge) + '</span>' : '') +
            (o.over ? '<span class="c16-over">' + escapeHtml(o.over) + '</span>' : '') +
            (o.check ? '<span class="c16-check">' + Icons.svg('check', 20, 3) + '</span>' : '') +
            (o.pct != null ? '<div class="c16-bar"><i style="width:' + Math.max(0, Math.min(100, o.pct)) + '%"></i></div>' : '') +
        '</div>' +
        (o.title ? '<span class="c16-title">' + escapeHtml(o.title) + '</span>' : '') +
        (o.sub != null ? '<span class="c16-sub' + (o.subCls ? ' ' + o.subCls : '') + '">' + escapeHtml(o.sub) + '</span>' : '');
    Art.set(c.querySelector('img'), o.art);
    if (o.onClick) { c.addEventListener('click', o.onClick); }
    if (o.onHold)  { c.setAttribute('data-hold', ''); c._onHold = o.onHold; }
    return c;
}

/* recoloca o foco no item de mesma data-key depois de redesenhar um grupo */
function refocusKey(group, key) {
    if (!key) { return false; }
    var list = Nav.items(group);
    for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute('data-key') === key) { Nav.focusIndex(group, i); return true; }
    }
    return false;
}


/* h('div', 'card', '<b>x</b>') -> elemento */
function h(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (html != null) { e.innerHTML = html; }
    return e;
}

/* cor estavel por titulo (reserva quando nao ha arte) */
function toneOf(s) {
    var hsh = 0;
    s = String(s || 'x');
    for (var i = 0; i < s.length; i++) { hsh = (hsh * 31 + s.charCodeAt(i)) | 0; }
    var hue = Math.abs(hsh) % 360;
    return 'linear-gradient(150deg,hsl(' + hue + ',34%,24%),hsl(' + ((hue + 40) % 360) + ',30%,12%))';
}

/* Imagens: o src so e definido quando a imagem chega perto da area visivel
 * (IntersectionObserver percebe tambem a rolagem por transform). Enquanto
 * isso - ou se o arquivo nao existir - fica o fundo de cor do elemento pai. */
var Art = (function () {
    var io = null;
    if (window.IntersectionObserver) {
        io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) { return; }
                io.unobserve(en.target);
                load(en.target);
            });
        }, { rootMargin: '400px' });
    }

    function load(img) {
        var url = img.getAttribute('data-src');
        if (!url || img.getAttribute('src')) { return; }
        img.onload  = function () { img.classList.add('loaded'); };
        img.onerror = function () { img.classList.remove('loaded'); img.removeAttribute('src'); };
        img.src = url;
    }

    /* set(img, url, eager) - eager = carrega ja (destaque, fundo da tela) */
    function set(img, url, eager) {
        if (!img) { return; }
        if (!url) {                       // sem arte: tira a anterior (senao fica a do titulo de antes)
            if (io) { io.unobserve(img); }
            img.removeAttribute('data-src');
            img.removeAttribute('src');
            img.classList.remove('loaded');
            return;
        }
        if (img.getAttribute('data-src') === url && img.getAttribute('src')) { return; }
        img.removeAttribute('src');
        img.classList.remove('loaded');
        img.setAttribute('data-src', url);
        if (eager || !io) { load(img); } else { io.observe(img); }
    }

    /* solta as imagens de um container (sair da tela libera memoria); elas
       voltam a carregar sozinhas quando o container aparecer de novo */
    function release(container) {
        if (!container) { return; }
        Array.prototype.forEach.call(container.querySelectorAll('img[data-src]'), function (img) {
            img.removeAttribute('src');
            img.classList.remove('loaded');
            if (io) { io.observe(img); }
        });
    }

    return { set: set, release: release };
})();
