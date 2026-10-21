#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createServer } from './index.ts';

function parseArgs(argv: string[]) {
  const opts = { port: Number(process.env.GIT_VIEW_PORT ?? 7420), dev: false, open: true, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev') opts.dev = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('用法: git-view [仓库目录] [--port 7420] [--no-open]');
      process.exit(0);
    } else if (!a.startsWith('-')) opts.repo = path.resolve(a);
  }
  return opts;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

const opts = parseArgs(process.argv.slice(2));
const server = createServer({
  port: opts.port,
  host: '127.0.0.1',
  devOrigins: opts.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${opts.port} 已被占用，可使用 --port 指定其它端口`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(opts.port, '127.0.0.1', () => {
  const base = opts.dev ? 'http://localhost:5173' : `http://localhost:${opts.port}`;
  const url = opts.repo ? `${base}/?repo=${encodeURIComponent(opts.repo)}` : base;
  console.log(`Git View API 已启动: http://127.0.0.1:${opts.port}`);
  if (!opts.dev) {
    console.log(`在浏览器中打开: ${url}`);
    if (opts.open) openBrowser(url);
  }
});
