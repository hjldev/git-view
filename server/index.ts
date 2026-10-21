import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlers, resolveRepo } from './api.ts';
import { GitError } from './git.ts';
import { subscribe } from './watcher.ts';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  port: number;
  host: string;
  /** Extra origins allowed to call the API (the Vite dev server). */
  devOrigins?: string[];
}

function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建。请运行 `npm run build`，或使用 `npm run dev` 进行开发。');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

export function createServer(opts: ServerOptions) {
  const allowedOrigins = new Set([
    `http://localhost:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
    ...(opts.devOrigins ?? []),
  ]);

  return http.createServer(async (req, res) => {
    // Block DNS-rebinding and cross-site requests: this server runs git commands.
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.writeHead(403).end('Forbidden origin');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res);
      return;
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      try {
        const ctx = await resolveRepo(url.searchParams.get('repo') ?? '');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        subscribe(ctx.root, ctx.gitDir, res);
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      sendJson(res, 415, { error: 'Content-Type 必须为 application/json' });
      return;
    }
    const name = url.pathname.slice(5);
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) {
      sendJson(res, 404, { error: `未知接口: ${name}` });
      return;
    }
    const started = Date.now();
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const data = await handler(body);
      sendJson(res, 200, { data });
      if (process.env.GIT_VIEW_DEBUG) console.log(`${name} ${Date.now() - started}ms`);
    } catch (e) {
      const err = e as Error;
      const payload: Record<string, unknown> = { error: err.message };
      if (e instanceof GitError) {
        payload.command = `git ${e.args.join(' ')}`;
        payload.stderr = e.stderr;
      }
      if (process.env.GIT_VIEW_DEBUG) console.error(name, err);
      sendJson(res, 500, payload);
    }
  });
}
