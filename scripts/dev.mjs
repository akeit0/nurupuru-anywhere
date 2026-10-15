import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildExtension } from './build.mjs';

const watcher = await buildExtension({ watch: true });
const routes = new Map([
  ['/dev/', ['dev/index.html', 'text/html; charset=utf-8']],
  ['/dev/index.html', ['dev/index.html', 'text/html; charset=utf-8']],
  ['/dev/preview.js', ['dev/preview.js', 'text/javascript; charset=utf-8']],
  ['/dist/content.js', ['dist/content.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer(async (request, response) => {
  if (new URL(request.url, 'http://localhost').pathname === '/') { response.writeHead(302, { Location: '/dev/' });response.end();return; }
  const route = routes.get(new URL(request.url, 'http://localhost').pathname);
  if (!route) { response.writeHead(404);response.end();return; }
  try { const content = await readFile(new URL('../' + route[0], import.meta.url));response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });response.end(content); }
  catch { response.writeHead(500);response.end('Build failed. Check the terminal.'); }
});
server.on('error', async error => { console.error(error.message);await watcher.dispose();process.exitCode = 1; });
server.listen(4174, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:4174/dev/ — reload after edits.'));
process.on('SIGINT', async () => { server.close();await watcher.dispose(); });
