import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Author,
  Branch,
  ChangedFile,
  Commit,
  CommitDetail,
  ConflictVersions,
  DiffSpec,
  FileDiff,
  FsListing,
  LogQuery,
  LogResult,
  OpResult,
  RecentRepo,
  RefsResult,
  RepoInfo,
  RepoState,
  StashEntry,
  Tag,
  WorkingStatus,
} from '../shared/types.ts';
import { git, gitOp, GitError, runGit, withRepoLock } from './git.ts';
import {
  FS,
  LOG_FORMAT,
  parseBlame,
  parseDecorations,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  RS,
} from './parsers.ts';

type Body = Record<string, any>;
type Handler = (body: Body) => Promise<unknown>;

const NETWORK_TIMEOUT = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Repository resolution

interface RepoCtx {
  root: string;
  gitDir: string;
}

const repoCache = new Map<string, RepoCtx>();

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function resolveRepo(p: string): Promise<RepoCtx> {
  if (!p || typeof p !== 'string') throw new Error('未指定仓库路径');
  const abs = path.resolve(expandHome(p.trim()));
  const cached = repoCache.get(abs);
  if (cached && existsSync(cached.gitDir)) return cached;
  if (!existsSync(abs)) throw new Error(`目录不存在: ${abs}`);
  let out: string;
  try {
    out = await git(abs, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  } catch {
    throw new Error(`不是 Git 仓库: ${abs}`);
  }
  const [root, gitDir] = out.trim().split('\n');
  const ctx = { root: path.resolve(root), gitDir: path.resolve(gitDir) };
  repoCache.set(abs, ctx);
  repoCache.set(ctx.root, ctx);
  return ctx;
}

const repo = (b: Body) => resolveRepo(b.repo);

function safePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel) throw new Error('无效的文件路径');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`路径越界: ${rel}`);
  return abs;
}

function paths(b: Body): string[] {
  const p = b.paths;
  if (!Array.isArray(p) || p.length === 0 || p.some((x) => typeof x !== 'string' || !x)) {
    throw new Error('未指定文件');
  }
  return p;
}

function refArg(v: unknown, what = '引用'): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少${what}`);
  // Refuse anything that could be parsed as an option.
  if (v.startsWith('-')) throw new Error(`无效的${what}: ${v}`);
  return v.trim();
}

function repoState(gitDir: string): RepoState {
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebasing';
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merging';
  if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'reverting';
  if (existsSync(path.join(gitDir, 'BISECT_LOG'))) return 'bisecting';
  return 'clean';
}

const emptyTreeCache = new Map<string, string>();
async function emptyTree(root: string): Promise<string> {
  let h = emptyTreeCache.get(root);
  if (!h) {
    h = (await git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
    emptyTreeCache.set(root, h);
  }
  return h;
}

async function hasConflicts(root: string): Promise<boolean> {
  const out = await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return out.trim().length > 0;
}

/**
 * Runs a state-changing operation under the repository lock. Failures that
 * leave unmerged paths behind are reported as conflicts instead of errors.
 */
async function op(root: string, fn: () => Promise<string>): Promise<OpResult> {
  return withRepoLock(root, async () => {
    try {
      return { ok: true, output: await fn() };
    } catch (e) {
      if (await hasConflicts(root)) {
        const msg = e instanceof GitError ? [e.stdout, e.stderr].join('\n').trim() : String(e);
        return { ok: false, conflicts: true, output: msg };
      }
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Recent repositories

const CONFIG_DIR = path.join(os.homedir(), '.git-view');
const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');

async function readRecent(): Promise<RecentRepo[]> {
  try {
    const list = JSON.parse(await fs.readFile(RECENT_FILE, 'utf8')) as RecentRepo[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeRecent(list: RecentRepo[]) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(RECENT_FILE, JSON.stringify(list.slice(0, 30), null, 2));
}

async function touchRecent(root: string) {
  const list = (await readRecent()).filter((r) => r.path !== root);
  list.unshift({ path: root, name: path.basename(root), openedAt: Date.now() });
  await writeRecent(list);
}

// ---------------------------------------------------------------------------
// Read handlers

async function repoInfo(ctx: RepoCtx): Promise<RepoInfo> {
  const { root, gitDir } = ctx;
  const [headRef, headHash, remotesOut, userName, userEmail] = await Promise.all([
    git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1] }).then((s) => s.trim() || null),
    git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] }).then((s) => s.trim() || null),
    git(root, ['remote', '-v']),
    git(root, ['config', 'user.name'], { okCodes: [1] }).then((s) => s.trim()),
    git(root, ['config', 'user.email'], { okCodes: [1] }).then((s) => s.trim()),
  ]);
  const remotes = new Map<string, { name: string; fetchUrl: string; pushUrl: string }>();
  for (const line of remotesOut.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const r = remotes.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    remotes.set(m[1], r);
  }
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (headRef && headHash) {
    upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [128] })).trim() || null;
    if (upstream) {
      const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { okCodes: [128] });
      const [a, b] = counts.trim().split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    }
  }
  return {
    root,
    name: path.basename(root),
    gitDir,
    head: headRef,
    headHash,
    detached: !headRef,
    state: repoState(gitDir),
    upstream,
    ahead,
    behind,
    remotes: [...remotes.values()],
    userName,
    userEmail,
  };
}

async function log(root: string, q: LogQuery): Promise<LogResult> {
  const max = Math.min(Math.max(Number(q.max) || 1000, 1), 50000);
  const order = q.order === 'topo' ? '--topo-order' : '--date-order';
  const args = ['log', '--decorate=full', `--format=${LOG_FORMAT}`, order, `-n${max + 1}`];
  if (q.skip) args.push(`--skip=${Number(q.skip)}`);
  const flat = !!(q.author || q.grep || q.since || q.until);
  if (q.author) args.push(`--author=${q.author}`, '--regexp-ignore-case');
  if (q.grep) args.push(`--grep=${q.grep}`, '--regexp-ignore-case', '--fixed-strings');
  if (q.since) args.push(`--since=${q.since}`);
  if (q.until) args.push(`--until=${q.until}`);
  if (q.path) args.push('--parents');
  if (q.range) args.push(refArg(q.range, '范围'));
  else if (q.branches && q.branches.length) args.push(...q.branches.map((b) => refArg(b, '分支')));
  else args.push('--branches', '--remotes', '--tags', 'HEAD');
  args.push('--');
  if (q.path) args.push(q.path);

  let out: string;
  try {
    out = await git(root, args);
  } catch (e) {
    // Fresh repository without commits.
    if (e instanceof GitError && /does not have any commits|unknown revision|bad default revision/.test(e.stderr)) {
      return { commits: [], hasMore: false, flat };
    }
    throw e;
  }
  let commits = parseLog(out);

  // The text filter also matches commit hashes, like IDEA's log search.
  if (q.grep && /^[0-9a-f]{4,64}$/i.test(q.grep) && !q.skip) {
    const h = (await git(root, ['rev-parse', '-q', '--verify', `${q.grep}^{commit}`], { okCodes: [1, 128] })).trim();
    if (h && !commits.some((c) => c.hash === h)) {
      const one = parseLog(await git(root, ['log', '--decorate=full', `--format=${LOG_FORMAT}`, '-n1', h]));
      commits = [...one, ...commits];
    }
  }
  const hasMore = commits.length > max;
  if (hasMore) commits = commits.slice(0, max);
  return { commits, hasMore, flat };
}

async function changedFilesBetween(root: string, from: string, to: string | null, extra: string[] = []): Promise<ChangedFile[]> {
  const range = to ? [from, to] : [from];
  const [ns, num] = await Promise.all([
    git(root, ['diff', '-z', '-M', '--name-status', ...extra, ...range, '--']),
    git(root, ['diff', '-z', '-M', '--numstat', ...extra, ...range, '--']),
  ]);
  const stats = parseNumstat(num);
  return parseNameStatus(ns).map((f) => {
    const s = stats.get(f.path);
    return s ? { ...f, additions: s.add, deletions: s.del, binary: s.binary } : f;
  });
}

async function commitDetail(root: string, hash: string): Promise<CommitDetail> {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s', '%b'].join('%x1f');
  const out = await git(root, ['show', '-s', '--decorate=full', `--format=${fmt}`, refArg(hash, '提交'), '--']);
  const f = out.replace(/\n$/, '').split(FS);
  const parents = f[1] ? f[1].split(' ') : [];
  const base = parents[0] ?? (await emptyTree(root));
  const files = await changedFilesBetween(root, base, f[0]);
  return {
    hash: f[0],
    parents,
    authorName: f[2],
    authorEmail: f[3],
    authorDate: Number(f[4]),
    committerName: f[5],
    committerEmail: f[6],
    committerDate: Number(f[7]),
    refs: parseDecorations(f[8]),
    subject: f[9],
    body: f.slice(10).join(FS).trim(),
    files,
  };
}

async function status(ctx: RepoCtx): Promise<WorkingStatus> {
  const out = await git(ctx.root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  return { ...parseStatus(out), state: repoState(ctx.gitDir) };
}

function parseTrack(track: string) {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.includes('gone'),
  };
}

async function refs(root: string): Promise<RefsResult> {
  const fmt = [
    '%(refname)',
    '%(objectname)',
    '%(objecttype)',
    '%(*objectname)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(HEAD)',
    '%(creatordate:unix)',
    '%(contents:subject)',
  ].join('%1f');
  const [out, headHash] = await Promise.all([
    git(root, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] }).then((s) => s.trim() || null),
  ]);
  const local: Branch[] = [];
  const remote: Branch[] = [];
  const tags: Tag[] = [];
  let head: string | null = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const f = line.split(FS);
    const [refname, oid, type, peeled, upstream, track, isHead, date] = f;
    const subject = f.slice(8).join(FS);
    if (refname.startsWith('refs/heads/')) {
      const t = parseTrack(track);
      const name = refname.slice(11);
      if (isHead === '*') head = name;
      local.push({
        name,
        fullName: refname,
        hash: oid,
        isRemote: false,
        isHead: isHead === '*',
        upstream: upstream || null,
        ahead: t.ahead,
        behind: t.behind,
        upstreamGone: t.gone,
        subject,
        date: Number(date),
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice(13);
      if (name.endsWith('/HEAD')) continue;
      remote.push({
        name,
        fullName: refname,
        hash: oid,
        isRemote: true,
        isHead: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamGone: false,
        subject,
        date: Number(date),
      });
    } else if (refname.startsWith('refs/tags/')) {
      tags.push({
        name: refname.slice(10),
        hash: type === 'tag' ? peeled || oid : oid,
        annotated: type === 'tag',
        subject,
        date: Number(date),
      });
    }
  }
  tags.sort((a, b) => b.date - a.date);
  return { head, headHash, local, remote, tags };
}

async function stashList(root: string): Promise<StashEntry[]> {
  const out = await git(root, ['stash', 'list', `--format=%gd%x1f%H%x1f%ct%x1f%gs`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [ref, hash, date, ...rest] = line.split(FS);
      const subject = rest.join(FS);
      const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(subject);
      return {
        index,
        ref,
        hash,
        date: Number(date),
        branch: m ? m[1] : '',
        message: m ? m[2] : subject,
      };
    });
}

async function stashFiles(root: string, index: number): Promise<(ChangedFile & { untracked?: boolean })[]> {
  const ref = `stash@{${Number(index)}}`;
  const files: (ChangedFile & { untracked?: boolean })[] = await changedFilesBetween(root, `${ref}^1`, ref);
  const u = (await git(root, ['rev-parse', '-q', '--verify', `${ref}^3`], { okCodes: [1, 128] })).trim();
  if (u) {
    const out = await git(root, ['ls-tree', '-r', '-z', '--name-only', u]);
    for (const p of out.split('\0').filter(Boolean)) files.push({ path: p, status: 'A', untracked: true });
  }
  return files;
}

async function diff(root: string, spec: DiffSpec, context: number, ignoreWs: boolean): Promise<FileDiff[]> {
  const base = ['diff', '--no-color', '--no-ext-diff', '-M', `--unified=${context}`];
  if (ignoreWs) base.push('--ignore-space-change');
  const pathspec = (p?: string, o?: string) => (p ? ['--', ...(o && o !== p ? [o, p] : [p])] : ['--']);
  let args: string[];
  let okCodes: number[] | undefined;
  switch (spec.kind) {
    case 'commit': {
      let parent = spec.parent;
      if (!parent) {
        const ps = (await git(root, ['rev-list', '--parents', '-n1', refArg(spec.hash, '提交')])).trim().split(' ');
        parent = ps[1] ?? (await emptyTree(root));
      }
      args = [...base, refArg(parent), refArg(spec.hash), ...pathspec(spec.path, spec.oldPath)];
      break;
    }
    case 'unstaged':
      args = [...base, ...pathspec(spec.path)];
      break;
    case 'staged':
      args = [...base, '--cached', ...pathspec(spec.path, spec.oldPath)];
      break;
    case 'untracked':
      safePath(root, spec.path);
      args = [...base, '--no-index', '--', '/dev/null', spec.path];
      okCodes = [1];
      break;
    case 'stash': {
      const ref = `stash@{${Number(spec.index)}}`;
      args = spec.untracked
        ? [...base, await emptyTree(root), `${ref}^3`, ...pathspec(spec.path)]
        : [...base, `${ref}^1`, ref, ...pathspec(spec.path, spec.oldPath)];
      break;
    }
    case 'refs':
      args = [...base, refArg(spec.from), refArg(spec.to), ...pathspec(spec.path, spec.oldPath)];
      break;
    case 'worktree-vs-ref':
      args = [...base, refArg(spec.ref), ...pathspec(spec.path)];
      break;
    default:
      throw new Error('未知的 diff 类型');
  }
  const r = await runGit(args, { cwd: root, okCodes, maxBytes: 16 * 1024 * 1024 });
  const files = parseDiff(r.stdout);
  if (r.truncated) files.forEach((f) => (f.truncated = true));
  return files;
}

async function fileHistory(
  root: string,
  file: string,
  max: number,
): Promise<(Commit & { path: string; oldPath?: string; status: string })[]> {
  const out = await git(root, [
    'log',
    '--follow',
    '-M',
    '--decorate=full',
    `--format=%x1e${LOG_FORMAT.replace(/%x1e$/, '')}`,
    '--name-status',
    `-n${Math.min(max || 500, 5000)}`,
    '--',
    file,
  ]);
  const result: (Commit & { path: string; oldPath?: string; status: string })[] = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [commit] = parseLog(lines[0] + RS);
    if (!commit) continue;
    let p = file;
    let oldPath: string | undefined;
    let st = 'M';
    for (const l of lines.slice(1)) {
      if (!l.trim()) continue;
      const parts = l.split('\t');
      st = parts[0][0];
      p = parts[parts.length - 1];
      oldPath = parts.length > 2 ? parts[1] : undefined;
    }
    result.push({ ...commit, path: p, oldPath, status: st });
  }
  return result;
}

async function conflictVersions(ctx: RepoCtx, file: string): Promise<ConflictVersions> {
  const { root, gitDir } = ctx;
  const stage = (n: number) =>
    runGit(['show', `:${n}:${file}`], { cwd: root, okCodes: [128] }).then((r) => (r.code === 0 ? r.stdout : null));
  const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
  let working: string | null = null;
  try {
    working = await fs.readFile(safePath(root, file), 'utf8');
  } catch {
    working = null;
  }
  const short = async (ref: string) =>
    (await git(root, ['log', '-1', '--format=%h %s', ref], { okCodes: [128] }).catch(() => '')).trim();
  const head = (await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1] })).trim();
  let oursLabel = head ? `当前分支 ${head}` : `HEAD ${await short('HEAD')}`;
  let theirsLabel = '传入的更改';
  const state = repoState(gitDir);
  if (state === 'merging') {
    const msg = await fs.readFile(path.join(gitDir, 'MERGE_MSG'), 'utf8').catch(() => '');
    const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg);
    theirsLabel = m ? `合并来源 ${m[1]}` : `MERGE_HEAD ${await short('MERGE_HEAD')}`;
  } else if (state === 'rebasing') {
    oursLabel = `变基目标 ${await short('HEAD')}`;
    theirsLabel = `正在应用 ${await short('REBASE_HEAD')}`;
  } else if (state === 'cherry-picking') {
    theirsLabel = `优选 ${await short('CHERRY_PICK_HEAD')}`;
  } else if (state === 'reverting') {
    theirsLabel = `还原 ${await short('REVERT_HEAD')}`;
  }
  return { path: file, base, ours, theirs, working, oursLabel, theirsLabel };
}

async function listDir(p: string | undefined): Promise<FsListing> {
  const dir = path.resolve(expandHome(p?.trim() || os.homedir()));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: FsListing['entries'] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    result.push({ name: e.name, path: full, isRepo: existsSync(path.join(full, '.git')) });
  }
  result.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries: result };
}

// ---------------------------------------------------------------------------
// Write helpers

async function isMergeCommit(root: string, hash: string): Promise<boolean> {
  const ps = (await git(root, ['rev-list', '--parents', '-n1', hash])).trim().split(' ');
  return ps.length > 2;
}

async function deleteUntracked(root: string, files: string[]) {
  for (const f of files) await fs.rm(safePath(root, f), { recursive: true, force: true });
}

const localChangesWouldBeOverwritten = (e: unknown) =>
  e instanceof GitError && /would be overwritten|overwritten by checkout|commit your changes or stash them/i.test(e.stderr);

// ---------------------------------------------------------------------------
// Handlers

export const handlers: Record<string, Handler> = {
  // --- repositories -------------------------------------------------------
  'repo.recent': async () => {
    const list = await readRecent();
    return list.filter((r) => existsSync(r.path));
  },
  'repo.removeRecent': async (b) => {
    await writeRecent((await readRecent()).filter((r) => r.path !== b.path));
    return true;
  },
  'repo.open': async (b) => {
    const ctx = await resolveRepo(b.path);
    await touchRecent(ctx.root);
    return repoInfo(ctx);
  },
  'repo.info': async (b) => repoInfo(await repo(b)),
  'repo.init': async (b) => {
    const dir = path.resolve(expandHome(String(b.path ?? '')));
    await fs.mkdir(dir, { recursive: true });
    await git(dir, ['init']);
    return handlers['repo.open']({ path: dir });
  },
  'repo.clone': async (b) => {
    const url = refArg(b.url, '仓库地址');
    const parent = path.resolve(expandHome(String(b.parent ?? '')));
    const name = String(b.name || path.basename(url).replace(/\.git$/, ''));
    if (!name || name.includes('/') || name.startsWith('.')) throw new Error('无效的目录名');
    const target = path.join(parent, name);
    if (existsSync(target)) throw new Error(`目录已存在: ${target}`);
    await fs.mkdir(parent, { recursive: true });
    await gitOp(parent, ['clone', '--', url, name], { timeoutMs: 60 * 60 * 1000 });
    return handlers['repo.open']({ path: target });
  },
  'fs.list': async (b) => listDir(b.path),

  // --- log & commits ------------------------------------------------------
  log: async (b) => log((await repo(b)).root, b.query ?? {}),
  'log.authors': async (b) => {
    const out = await git((await repo(b)).root, ['log', '--branches', '--remotes', '--format=%an%x1f%ae']).catch(() => '');
    const map = new Map<string, Author>();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, email] = line.split(FS);
      const a = map.get(name) ?? { name, email, count: 0 };
      a.count++;
      map.set(name, a);
    }
    return [...map.values()].sort((a, b2) => b2.count - a.count);
  },
  'commit.detail': async (b) => commitDetail((await repo(b)).root, b.hash),
  'commit.branches': async (b) => {
    const out = await git((await repo(b)).root, [
      'branch',
      '-a',
      '--format=%(refname:short)',
      '--contains',
      refArg(b.hash, '提交'),
    ]);
    return out.split('\n').filter((s) => s && !s.endsWith('/HEAD'));
  },
  'commit.message': async (b) => {
    const { root } = await repo(b);
    return (await git(root, ['log', '-1', '--format=%B', refArg(b.hash ?? 'HEAD')], { okCodes: [128] })).trimEnd();
  },
  status: async (b) => status(await repo(b)),
  refs: async (b) => refs((await repo(b)).root),
  diff: async (b) => diff((await repo(b)).root, b.spec, Math.min(Number(b.context ?? 100000), 1000000), !!b.ignoreWs),
  'diff.files': async (b) => {
    const { root } = await repo(b);
    if (b.to === 'WORKTREE') return changedFilesBetween(root, refArg(b.from), null);
    return changedFilesBetween(root, refArg(b.from), refArg(b.to));
  },
  'file.content': async (b) => {
    const { root } = await repo(b);
    if (!b.rev) return fs.readFile(safePath(root, b.path), 'utf8');
    return git(root, ['show', `${refArg(b.rev)}:${b.path}`], { maxBytes: 16 * 1024 * 1024 });
  },
  blame: async (b) => {
    const { root } = await repo(b);
    const args = ['blame', '--porcelain'];
    if (b.ignoreWs) args.push('-w');
    if (b.rev) args.push(refArg(b.rev));
    args.push('--', b.path);
    return parseBlame(await git(root, args), b.path, b.rev ?? null);
  },
  'file.history': async (b) => fileHistory((await repo(b)).root, b.path, Number(b.max) || 500),
  'branch.compare': async (b) => {
    const { root } = await repo(b);
    const a = refArg(b.a);
    const c = refArg(b.b);
    const fmt = ['log', '--decorate=full', `--format=${LOG_FORMAT}`, '-n500'];
    const [onlyA, onlyB] = await Promise.all([
      git(root, [...fmt, `${c}..${a}`, '--']).then(parseLog),
      git(root, [...fmt, `${a}..${c}`, '--']).then(parseLog),
    ]);
    return { onlyA, onlyB };
  },
  'push.preview': async (b) => {
    const { root } = await repo(b);
    const local = refArg(b.branch, '分支');
    const remote = refArg(b.remote, '远程');
    const target = String(b.remoteBranch || local);
    const remoteRef = `refs/remotes/${remote}/${target}`;
    const exists = (await git(root, ['rev-parse', '-q', '--verify', remoteRef], { okCodes: [1] })).trim();
    const range = exists ? [`${remoteRef}..${local}`] : [local, '--not', `--remotes=${remote}`];
    const commits = parseLog(await git(root, ['log', '--decorate=full', `--format=${LOG_FORMAT}`, '-n500', ...range, '--']));
    let behind = 0;
    if (exists) behind = Number((await git(root, ['rev-list', '--count', `${local}..${remoteRef}`])).trim());
    return { commits, newBranch: !exists, behind };
  },
  'stash.list': async (b) => stashList((await repo(b)).root),
  'stash.files': async (b) => stashFiles((await repo(b)).root, Number(b.index)),
  'conflict.versions': async (b) => conflictVersions(await repo(b), b.path),

  // --- working tree -------------------------------------------------------
  stage: async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['add', '-A', '--', ...paths(b)]));
  },
  'stage.all': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['add', '-A']));
  },
  unstage: async (b) => {
    const ctx = await repo(b);
    const { root } = ctx;
    return op(root, async () => {
      const hasHead = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] })).trim();
      if (!hasHead) return gitOp(root, ['rm', '--cached', '-r', '-q', '--', ...paths(b)]);
      return gitOp(root, ['reset', '-q', 'HEAD', '--', ...paths(b)]);
    });
  },
  'unstage.all': async (b) => {
    const { root } = await repo(b);
    return op(root, async () => {
      const hasHead = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] })).trim();
      if (!hasHead) return gitOp(root, ['rm', '--cached', '-r', '-q', '.']);
      return gitOp(root, ['reset', '-q']);
    });
  },
  /** Applies a patch to the index (or the working tree when `cached` is false). */
  'apply.patch': async (b) => {
    const { root } = await repo(b);
    const args = ['apply', '--whitespace=nowarn', '--unidiff-zero'];
    if (b.cached !== false) args.push('--cached');
    if (b.reverse) args.push('-R');
    args.push('-');
    return op(root, () => gitOp(root, args, { input: String(b.patch) }));
  },
  /** Reverts unstaged changes: working tree ← index. */
  'discard.unstaged': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['checkout', '--', ...paths(b)]));
  },
  /** IDEA "Rollback": staged + unstaged changes back to HEAD; newly added files are removed from the index. */
  rollback: async (b) => {
    const ctx = await repo(b);
    const { root } = ctx;
    return op(root, async () => {
      const ps = paths(b);
      const st = await status(ctx);
      const added = new Set(st.staged.filter((f) => f.status === 'A').map((f) => f.path));
      const tracked = ps.filter((p) => !added.has(p));
      const newFiles = ps.filter((p) => added.has(p));
      const outs: string[] = [];
      // Renamed files: restore the old path as well.
      const renamedFrom = st.staged.filter((f) => f.status === 'R' && ps.includes(f.path)).map((f) => f.oldPath!);
      if (newFiles.length || renamedFrom.length) {
        const rm = [...newFiles, ...st.staged.filter((f) => f.status === 'R' && ps.includes(f.path)).map((f) => f.path)];
        outs.push(await gitOp(root, ['rm', '--cached', '-q', '-r', '--', ...rm]));
        if (b.deleteAdded) await deleteUntracked(root, newFiles);
      }
      const restore = [...tracked.filter((p) => !st.staged.some((f) => f.status === 'R' && f.path === p)), ...renamedFrom];
      if (restore.length) {
        outs.push(await gitOp(root, ['checkout', 'HEAD', '--', ...restore]));
      }
      return outs.join('\n');
    });
  },
  'untracked.delete': async (b) => {
    const { root } = await repo(b);
    return op(root, async () => {
      const ps = paths(b);
      // Only delete files git reports as untracked.
      const out = await git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...ps]);
      const allowed = new Set(out.split('\0').filter(Boolean));
      const targets = ps.filter((p) => allowed.has(p));
      await deleteUntracked(root, targets);
      return `已删除 ${targets.length} 个文件`;
    });
  },
  'ignore.add': async (b) => {
    const { root } = await repo(b);
    return op(root, async () => {
      const file = path.join(root, '.gitignore');
      let content = await fs.readFile(file, 'utf8').catch(() => '');
      if (content && !content.endsWith('\n')) content += '\n';
      content += paths(b).map((p) => '/' + p.replace(/^\/+/, '')).join('\n') + '\n';
      await fs.writeFile(file, content);
      return '已添加到 .gitignore';
    });
  },
  commit: async (b) => {
    const { root } = await repo(b);
    const message = String(b.message ?? '');
    if (!message.trim() && !b.amend) throw new Error('提交信息不能为空');
    const args = ['commit', '-F', '-', '--cleanup=whitespace'];
    if (b.amend) args.push('--amend');
    if (b.only) args.push('--only');
    if (b.signoff) args.push('--signoff');
    if (b.noVerify) args.push('--no-verify');
    if (b.author) args.push(`--author=${b.author}`);
    if (b.all) args.push('--all');
    if (b.amend && !message.trim()) {
      args.splice(1, 3, '--no-edit');
    }
    return op(root, () => gitOp(root, args, { input: message }));
  },

  // --- branches -----------------------------------------------------------
  'branch.checkout': async (b) => {
    const { root } = await repo(b);
    const name = refArg(b.name, '分支');
    return op(root, async () => {
      const doCheckout = async () => {
        if (b.remote) {
          const slash = name.indexOf('/');
          const local = String(b.localName || name.slice(slash + 1));
          const exists = (await git(root, ['rev-parse', '-q', '--verify', `refs/heads/${local}`], { okCodes: [1] })).trim();
          if (exists) return gitOp(root, ['switch', '--', local]);
          return gitOp(root, ['switch', '--track', '-c', refArg(local, '分支'), name]);
        }
        if (b.detach) return gitOp(root, ['switch', '--detach', name]);
        return gitOp(root, ['switch', name, '--']);
      };
      if (!b.smart) return doCheckout();
      // Smart checkout: stash local changes, switch, then restore them.
      const stashed = await gitOp(root, ['stash', 'push', '--include-untracked', '-m', `git-view: 智能检出 ${name}`]);
      const didStash = !/No local changes/i.test(stashed);
      let out = await doCheckout();
      if (didStash) out += '\n' + (await gitOp(root, ['stash', 'pop']));
      return out;
    }).catch((e) => {
      if (localChangesWouldBeOverwritten(e)) return { ok: false, output: e.message, localChanges: true };
      throw e;
    });
  },
  'branch.create': async (b) => {
    const { root } = await repo(b);
    const name = refArg(b.name, '分支名');
    const start = b.start ? refArg(b.start) : 'HEAD';
    return op(root, async () => {
      const check = await runGit(['check-ref-format', '--branch', name], { cwd: root, okCodes: [1, 128] });
      if (check.code !== 0) throw new Error(`无效的分支名: ${name}`);
      if (b.checkout) return gitOp(root, ['switch', ...(b.force ? ['-C'] : ['-c']), name, start]);
      return gitOp(root, ['branch', ...(b.force ? ['-f'] : []), name, start]);
    });
  },
  'branch.rename': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['branch', '-m', refArg(b.oldName, '分支'), refArg(b.newName, '新名称')]));
  },
  'branch.delete': async (b) => {
    const { root } = await repo(b);
    const name = refArg(b.name, '分支');
    const hash = (await git(root, ['rev-parse', `refs/heads/${name}`])).trim();
    try {
      const r = await op(root, () => gitOp(root, ['branch', b.force ? '-D' : '-d', name]));
      return { ...r, hash };
    } catch (e) {
      if (e instanceof GitError && /not fully merged/.test(e.stderr)) {
        return { ok: false, notMerged: true, output: e.stderr.trim(), hash };
      }
      throw e;
    }
  },
  'branch.deleteRemote': async (b) => {
    const { root } = await repo(b);
    const full = refArg(b.name, '远程分支');
    const slash = full.indexOf('/');
    const remote = full.slice(0, slash);
    const branch = full.slice(slash + 1);
    return op(root, () => gitOp(root, ['push', remote, '--delete', branch], { timeoutMs: NETWORK_TIMEOUT }));
  },
  'branch.setUpstream': async (b) => {
    const { root } = await repo(b);
    const branch = refArg(b.branch, '分支');
    if (!b.upstream) return op(root, () => gitOp(root, ['branch', '--unset-upstream', branch]));
    return op(root, () => gitOp(root, ['branch', `--set-upstream-to=${refArg(b.upstream)}`, branch]));
  },
  merge: async (b) => {
    const { root } = await repo(b);
    const args = ['merge', '--no-edit', '--autostash'];
    if (b.noFF) args.push('--no-ff');
    if (b.ffOnly) args.push('--ff-only');
    if (b.squash) args.push('--squash');
    if (b.noCommit) args.push('--no-commit');
    if (b.message) args.push('-m', String(b.message));
    args.push(refArg(b.ref, '分支'));
    return op(root, () => gitOp(root, args));
  },
  rebase: async (b) => {
    const { root } = await repo(b);
    const args = ['rebase', '--autostash', refArg(b.onto, '目标')];
    if (b.branch) args.push(refArg(b.branch));
    return op(root, () => gitOp(root, args));
  },
  /** continue / abort / skip for merge, rebase, cherry-pick and revert. */
  'sequence.control': async (b) => {
    const ctx = await repo(b);
    const { root } = ctx;
    const action = String(b.action);
    if (!['continue', 'abort', 'skip'].includes(action)) throw new Error('无效的操作');
    const state = repoState(ctx.gitDir);
    const cmd: Record<string, string> = {
      merging: 'merge',
      rebasing: 'rebase',
      'cherry-picking': 'cherry-pick',
      reverting: 'revert',
    };
    const c = cmd[state];
    if (!c) throw new Error('当前没有进行中的合并/变基操作');
    return op(root, () => {
      if (c === 'merge' && action === 'continue') return gitOp(root, ['commit', '--no-edit']);
      if (c === 'merge' && action === 'skip') throw new Error('合并操作不支持跳过');
      return gitOp(root, [c, `--${action}`]);
    });
  },
  'cherry-pick': async (b) => {
    const { root } = await repo(b);
    const hashes: string[] = (b.hashes ?? []).map((h: string) => refArg(h, '提交'));
    if (!hashes.length) throw new Error('未选择提交');
    return op(root, async () => {
      const merge = hashes.length === 1 && (await isMergeCommit(root, hashes[0]));
      return gitOp(root, ['cherry-pick', ...(b.recordOrigin ? ['-x'] : []), ...(merge ? ['-m', '1'] : []), ...hashes]);
    });
  },
  revert: async (b) => {
    const { root } = await repo(b);
    const hashes: string[] = (b.hashes ?? []).map((h: string) => refArg(h, '提交'));
    if (!hashes.length) throw new Error('未选择提交');
    return op(root, async () => {
      const merge = hashes.length === 1 && (await isMergeCommit(root, hashes[0]));
      return gitOp(root, ['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), ...hashes]);
    });
  },
  reset: async (b) => {
    const { root } = await repo(b);
    const mode = String(b.mode ?? 'mixed');
    if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw new Error('无效的重置模式');
    return op(root, () => gitOp(root, ['reset', `--${mode}`, refArg(b.hash, '提交')]));
  },
  'checkout.revision': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['switch', '--detach', refArg(b.hash, '提交')]));
  },
  /** Interactive-rebase-like reword of HEAD / undo the last commit. */
  'commit.undo': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['reset', '--soft', 'HEAD~1']));
  },

  // --- tags ---------------------------------------------------------------
  'tag.create': async (b) => {
    const { root } = await repo(b);
    const name = refArg(b.name, '标签名');
    const args = ['tag'];
    if (b.message) args.push('-a', '-m', String(b.message));
    args.push(name, b.hash ? refArg(b.hash) : 'HEAD');
    return op(root, () => gitOp(root, args));
  },
  'tag.delete': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['tag', '-d', refArg(b.name, '标签')]));
  },
  'tag.push': async (b) => {
    const { root } = await repo(b);
    return op(root, () =>
      gitOp(root, ['push', refArg(b.remote, '远程'), `refs/tags/${refArg(b.name, '标签')}`], { timeoutMs: NETWORK_TIMEOUT }),
    );
  },
  'tag.deleteRemote': async (b) => {
    const { root } = await repo(b);
    return op(root, () =>
      gitOp(root, ['push', refArg(b.remote, '远程'), '--delete', `refs/tags/${refArg(b.name, '标签')}`], {
        timeoutMs: NETWORK_TIMEOUT,
      }),
    );
  },

  // --- remotes ------------------------------------------------------------
  fetch: async (b) => {
    const { root } = await repo(b);
    const args = ['fetch', '--prune'];
    if (b.remote) args.push(refArg(b.remote, '远程'));
    else args.push('--all');
    if (b.tags) args.push('--tags');
    return op(root, () => gitOp(root, args, { timeoutMs: NETWORK_TIMEOUT }));
  },
  pull: async (b) => {
    const { root } = await repo(b);
    const args = ['pull', '--no-edit', '--autostash'];
    if (b.mode === 'rebase') args.push('--rebase');
    else if (b.mode === 'ff-only') args.push('--ff-only');
    else args.push('--no-rebase');
    if (b.remote) args.push(refArg(b.remote, '远程'));
    if (b.remote && b.branch) args.push(refArg(b.branch, '分支'));
    return op(root, () => gitOp(root, args, { timeoutMs: NETWORK_TIMEOUT }));
  },
  push: async (b) => {
    const { root } = await repo(b);
    const remote = refArg(b.remote, '远程');
    const local = refArg(b.branch, '分支');
    const target = refArg(b.remoteBranch || local, '远程分支');
    const args = ['push'];
    if (b.force === 'lease') args.push('--force-with-lease');
    else if (b.force === 'force') args.push('--force');
    if (b.setUpstream) args.push('--set-upstream');
    if (b.tags) args.push('--follow-tags');
    if (b.noVerify) args.push('--no-verify');
    args.push(remote, `refs/heads/${local}:refs/heads/${target}`);
    try {
      return await op(root, () => gitOp(root, args, { timeoutMs: NETWORK_TIMEOUT }));
    } catch (e) {
      if (e instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/.test(e.stderr)) {
        return { ok: false, rejected: true, output: e.stderr.trim() };
      }
      throw e;
    }
  },
  'remote.add': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['remote', 'add', refArg(b.name, '名称'), refArg(b.url, '地址')]));
  },
  'remote.remove': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['remote', 'remove', refArg(b.name, '名称')]));
  },
  'remote.setUrl': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['remote', 'set-url', refArg(b.name, '名称'), refArg(b.url, '地址')]));
  },

  // --- stash --------------------------------------------------------------
  'stash.save': async (b) => {
    const { root } = await repo(b);
    const args = ['stash', 'push'];
    if (b.includeUntracked) args.push('--include-untracked');
    if (b.keepIndex) args.push('--keep-index');
    if (b.message) args.push('-m', String(b.message));
    if (Array.isArray(b.paths) && b.paths.length) args.push('--', ...paths(b));
    return op(root, () => gitOp(root, args));
  },
  'stash.apply': async (b) => {
    const { root } = await repo(b);
    const args = ['stash', b.pop ? 'pop' : 'apply'];
    if (b.reinstateIndex) args.push('--index');
    args.push(`stash@{${Number(b.index)}}`);
    return op(root, () => gitOp(root, args));
  },
  'stash.drop': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['stash', 'drop', `stash@{${Number(b.index)}}`]));
  },
  'stash.clear': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['stash', 'clear']));
  },
  'stash.branch': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['stash', 'branch', refArg(b.name, '分支名'), `stash@{${Number(b.index)}}`]));
  },

  // --- conflicts ----------------------------------------------------------
  'conflict.accept': async (b) => {
    const { root } = await repo(b);
    const side = b.side === 'theirs' ? 'theirs' : 'ours';
    return op(root, async () => {
      const outs: string[] = [];
      for (const p of paths(b)) {
        const stage = side === 'ours' ? 2 : 3;
        const has = await runGit(['cat-file', '-e', `:${stage}:${p}`], { cwd: root, okCodes: [1, 128] });
        if (has.code === 0) {
          outs.push(await gitOp(root, ['checkout', `--${side}`, '--', p]));
          outs.push(await gitOp(root, ['add', '--', p]));
        } else {
          // The chosen side deleted the file.
          outs.push(await gitOp(root, ['rm', '-q', '--', p]));
        }
      }
      return outs.filter(Boolean).join('\n');
    });
  },
  'conflict.resolve': async (b) => {
    const { root } = await repo(b);
    const file = String(b.path);
    return op(root, async () => {
      await fs.writeFile(safePath(root, file), String(b.content ?? ''));
      return gitOp(root, ['add', '--', file]);
    });
  },
  'conflict.markResolved': async (b) => {
    const { root } = await repo(b);
    return op(root, () => gitOp(root, ['add', '--', ...paths(b)]));
  },
};
