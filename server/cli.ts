#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './index.ts';

const USAGE = `用法: git-view [仓库目录] [--port 7420] [--no-open]

不指定目录时，打开当前所在的 Git 仓库（不在仓库中则显示欢迎页）。
已有 Git View 在运行时，直接在浏览器中打开该仓库。`;

function parseArgs(argv: string[]) {
  const opts = { port: Number(process.env.GIT_VIEW_PORT ?? 7420), dev: false, open: true, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev') opts.dev = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (!a.startsWith('-')) opts.repo = path.resolve(a);
  }
  return opts;
}

/** The repository containing the current directory, if any. */
function currentRepo(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** True when a Git View server already answers on the port. */
async function isGitViewRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/repo.recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    const json = (await res.json()) as { data?: unknown };
    return Array.isArray(json.data);
  } catch {
    return false;
  }
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.repo && !opts.dev) opts.repo = currentRepo();

const base = opts.dev ? 'http://localhost:5173' : `http://localhost:${opts.port}`;
const url = opts.repo ? `${base}/?repo=${encodeURIComponent(opts.repo)}` : base;

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!opts.dev && !existsSync(dist)) {
  console.warn(`提示: 前端尚未构建，请先在 ${path.dirname(dist)} 中运行 npm run build`);
}

const server = createServer({
  port: opts.port,
  host: '127.0.0.1',
  devOrigins: opts.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
});

server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    if (!opts.dev && (await isGitViewRunning(opts.port))) {
      console.log(`Git View 已在运行，在浏览器中打开: ${url}`);
      if (opts.open) openBrowser(url);
      process.exit(0);
    }
    console.error(`端口 ${opts.port} 已被其他程序占用，可使用 --port 指定其它端口`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(opts.port, '127.0.0.1', () => {
  console.log(`Git View API 已启动: http://127.0.0.1:${opts.port}`);
  if (!opts.dev) {
    console.log(`在浏览器中打开: ${url}`);
    console.log('按 Ctrl+C 停止');
    if (opts.open) openBrowser(url);
  }
});
