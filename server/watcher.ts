import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

export type ChangeKind = 'refs' | 'status';

interface RepoWatch {
  watcher: FSWatcher | null;
  clients: Set<ServerResponse>;
  pending: Set<ChangeKind>;
  timer: NodeJS.Timeout | null;
}

const watches = new Map<string, RepoWatch>();

// Files inside .git whose change means branches / HEAD / index moved.
const REF_FILES = /^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|packed-refs|refs[\\/].*|logs[\\/]HEAD|rebase-merge.*|rebase-apply.*)$/;
const IGNORED_DIRS = /(^|[\\/])(node_modules|\.idea|\.gradle|target|build|dist|out|\.next|\.cache|__pycache__)([\\/]|$)/;

function classify(gitDirRel: string | null, rel: string): ChangeKind | null {
  if (gitDirRel !== null) {
    if (rel === 'index') return 'status';
    if (REF_FILES.test(rel)) return 'refs';
    return null;
  }
  if (IGNORED_DIRS.test(rel)) return null;
  return 'status';
}

function flush(w: RepoWatch) {
  w.timer = null;
  const kinds = [...w.pending];
  w.pending.clear();
  const payload = `event: change\ndata: ${JSON.stringify({ kinds })}\n\n`;
  for (const c of w.clients) c.write(payload);
}

function startWatcher(root: string, gitDir: string, w: RepoWatch) {
  const relGit = path.relative(root, gitDir);
  const gitInside = !relGit.startsWith('..') && !path.isAbsolute(relGit);
  const onEvent = (base: 'root' | 'git') => (_type: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const name = filename.toString();
    let kind: ChangeKind | null;
    if (base === 'git') {
      kind = classify('', name);
    } else if (gitInside && (name === relGit || name.startsWith(relGit + path.sep))) {
      kind = classify('', name.slice(relGit.length + 1));
    } else {
      kind = classify(null, name);
    }
    if (!kind) return;
    w.pending.add(kind);
    if (!w.timer) w.timer = setTimeout(() => flush(w), 400);
  };
  try {
    w.watcher = watch(root, { recursive: true }, onEvent('root'));
    w.watcher.on('error', () => undefined);
    if (!gitInside) {
      const gw = watch(gitDir, { recursive: true }, onEvent('git'));
      gw.on('error', () => undefined);
      const orig = w.watcher;
      w.watcher = { close: () => (orig.close(), gw.close()) } as FSWatcher;
    }
  } catch {
    // Recursive watching unsupported: clients fall back to focus/poll refresh.
    w.watcher = null;
  }
}

export function subscribe(root: string, gitDir: string, res: ServerResponse) {
  let w = watches.get(root);
  if (!w) {
    w = { watcher: null, clients: new Set(), pending: new Set(), timer: null };
    watches.set(root, w);
    startWatcher(root, gitDir, w);
  }
  w.clients.add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ watching: !!w.watcher })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    w!.clients.delete(res);
    if (w!.clients.size === 0) {
      w!.watcher?.close();
      if (w!.timer) clearTimeout(w!.timer);
      watches.delete(root);
    }
  });
}
