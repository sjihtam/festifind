// Minimal static server for Festifind.
//
// Binds to 127.0.0.1:8888 on purpose: Spotify no longer accepts plain-http
// redirect URIs except for the loopback IP literal. `http://localhost:8888`
// is REJECTED by the Spotify dashboard; `http://127.0.0.1:8888` is accepted.
// Open the app at http://127.0.0.1:8888 or auth will fail.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8888;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }

  // Record mode (open the app with ?record): the browser posts every Spotify
  // API response here so the scoring can be replayed and tuned offline with
  // tools/replay.mjs — no further Spotify calls needed. Local loopback only,
  // and the file is gitignored: this is the user's listening data.
  if (req.method === 'POST' && pathname === '/snapshot') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      JSON.parse(body); // refuse to write garbage
      await writeFile(join(ROOT, 'data-snapshot.json'), body);
      console.log(`  Snapshot saved: data-snapshot.json (${(body.length / 1e6).toFixed(1)} MB)`);
      return send(res, 200, '{"ok":true}', 'application/json');
    } catch {
      return send(res, 400, '{"ok":false}', 'application/json');
    }
  }

  // Serve index.html for any directory request, the way GitHub Pages and every
  // other static host does — so testing from a subpath locally behaves the same.
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Back-compat: earlier versions used /callback as the OAuth redirect target.
  // The redirect URI is now the app's base URL, but honour old bookmarks.
  if (pathname === '/callback') pathname = '/index.html';

  // Contain path traversal: resolve, then verify the result is still under ROOT.
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }

  try {
    const body = await readFile(filePath);
    return send(res, 200, body, MIME[extname(filePath)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'Not found', 'text/plain');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Festifind running at  http://${HOST}:${PORT}\n`);
  console.log(`  Use that exact URL — not "localhost" — or Spotify auth will fail.\n`);
});
