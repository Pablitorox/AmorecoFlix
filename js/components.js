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

    return { svg: svg };
})();


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
        if (!url) { img.removeAttribute('data-src'); return; }
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
