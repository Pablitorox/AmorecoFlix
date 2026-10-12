/* Simulador da TV - servidor local. Ver LEIA.txt.
 *   node tools/simulador/serve.js            -> http://localhost:8765/test.html
 *   HD=F:/AmorecoFlix node ...serve.js       -> outra pasta de biblioteca
 * O HD real so e LIDO (/hd/...); o que o app grava fica na memoria do navegador. */
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', '..');
const here = __dirname;
const HD = path.resolve(process.env.HD || 'E:/AmorecoFlix');
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8'
};
// arquivos do app servidos da pasta do projeto (nada de .env, .git, scripts)
const appFiles = ['index.html', 'app.js', 'style.css', 'icon.png'];
const appDirs = ['js/', 'fonts/'];

function inside(base, p) { const r = path.resolve(base, p); return (r === base || r.startsWith(base + path.sep)) ? r : null; }
function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' }); res.end(body); }

http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let f = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    res.setHeader('Cache-Control', 'no-store');

    // ---- HD real (somente leitura) ----
    if (f === 'hd/stat' || f === 'hd/list') {
        const p = inside(HD, u.searchParams.get('p') || '');
        if (!p || !fs.existsSync(p)) { return send(res, 404, 'null', types['.json']); }
        const st = fs.statSync(p);
        if (f === 'hd/stat') {
            return send(res, 200, JSON.stringify({ isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }), types['.json']);
        }
        const out = fs.readdirSync(p, { withFileTypes: true }).map(d => {
            let s = null; try { s = fs.statSync(path.join(p, d.name)); } catch (e) {}
            return { name: d.name, isDir: d.isDirectory(), size: s ? s.size : 0, mtime: s ? s.mtimeMs : 0 };
        });
        return send(res, 200, JSON.stringify(out), types['.json']);
    }
    if (f.startsWith('hd/raw/')) {
        const p = inside(HD, f.slice(7));
        if (!p) { return send(res, 403, ''); }
        return fs.stat(p, (err, st) => {
            if (err || !st.isFile()) { return send(res, 404, ''); }
            if (st.size > 50 * 1024 * 1024) { return send(res, 413, 'arquivo de video nao e servido'); }
            res.writeHead(200, { 'Content-Type': types[path.extname(p).toLowerCase()] || 'application/octet-stream' });
            fs.createReadStream(p).pipe(res);
        });
    }

    // ---- app com a TV falsa ----
    if (f === 'test.html' || f === 'test-old.html') {
        // index.html real com o webapis.js da TV trocado pela TV falsa (mock.js)
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
            .replace(/<script src="\$WEBAPIS\/webapis\/webapis\.js"><\/script>/, '<script src="mock.js"></script>')
            .replace('<script src="app.js"></script>', f === 'test-old.html' ? '<script src="app-old.js"></script>' : '<script src="app.js"></script>');
        return send(res, 200, html, types['.html']);
    }
    let src = null;
    if (f === 'mock.js' || f === 'app-old.js') { src = path.join(here, f); }
    else if (appFiles.indexOf(f) !== -1 || appDirs.some(d => f.startsWith(d))) { src = inside(root, f); }
    if (!src) { return send(res, 404, ''); }
    fs.readFile(src, (err, data) => {
        if (err) { return send(res, 404, ''); }
        res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(8765, '127.0.0.1', () => console.log('simulador em http://localhost:8765/test.html  (HD: ' + HD + ')'));
