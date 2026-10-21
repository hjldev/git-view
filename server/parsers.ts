import type {
  BlameCommit,
  BlameLine,
  BlameResult,
  ChangedFile,
  Commit,
  DiffHunk,
  DiffLine,
  FileDiff,
  FileStatus,
  RefLabel,
  WorkingStatus,
} from '../shared/types.ts';

export const FS = '\x1f'; // field separator
export const RS = '\x1e'; // record separator

// %D with --decorate=full gives fully qualified ref names.
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s'].join('%x1f') + '%x1e';

export function parseDecorations(d: string): RefLabel[] {
  if (!d.trim()) return [];
  const refs: RefLabel[] = [];
  for (let part of d.split(', ')) {
    part = part.trim();
    if (!part) continue;
    if (part === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' });
      continue;
    }
    if (part.startsWith('HEAD -> ')) {
      refs.push({ type: 'head', name: 'HEAD' });
      part = part.slice(8);
    }
    if (part.startsWith('tag: ')) {
      refs.push({ type: 'tag', name: part.slice(5).replace(/^refs\/tags\//, '') });
    } else if (part.startsWith('refs/heads/')) {
      refs.push({ type: 'local', name: part.slice(11) });
    } else if (part.startsWith('refs/remotes/')) {
      const name = part.slice(13);
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name });
    } else if (part === 'refs/stash') {
      refs.push({ type: 'stash', name: 'stash' });
    }
  }
  return refs;
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const f = r.split(FS);
    if (f.length < 9) continue;
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]),
      committerName: f[5],
      committerDate: Number(f[6]),
      refs: parseDecorations(f[7]),
      subject: f.slice(8).join(FS),
    });
  }
  return commits;
}

function statusLetter(code: string): FileStatus {
  const c = code[0];
  if ('AMDRCTU'.includes(c)) return c as FileStatus;
  return 'M';
}

/** Parses `git diff --name-status -z` / `git diff-tree --name-status -z` output. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const status = statusLetter(code);
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push({ path, oldPath, status });
    } else {
      files.push({ path: parts[i++], status });
    }
  }
  return files;
}

/** Parses `--numstat -z` output into a map keyed by the new path. */
export function parseNumstat(out: string): Map<string, { add: number; del: number; binary: boolean }> {
  const map = new Map<string, { add: number; del: number; binary: boolean }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      i++; // old path
      path = parts[i++];
    }
    const binary = m[1] === '-';
    map.set(path, { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

/** Parses `git status --porcelain=v2 -z --branch --untracked-files=all`. */
export function parseStatus(out: string): Omit<WorkingStatus, 'state'> {
  const st: Omit<WorkingStatus, 'state'> = {
    branch: null,
    headHash: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') st.headHash = val === '(initial)' ? null : val;
      else if (key === 'branch.head') st.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') st.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      const fields = line.split(' ');
      const xy = fields[1];
      let path: string;
      let oldPath: string | undefined;
      if (kind === '1') {
        path = fields.slice(8).join(' ');
      } else {
        path = fields.slice(9).join(' ');
        oldPath = parts[++i];
      }
      const x = xy[0];
      const y = xy[1];
      if (x !== '.') st.staged.push({ path, oldPath: x === 'R' || x === 'C' ? oldPath : undefined, status: statusLetter(x) });
      if (y !== '.') st.unstaged.push({ path, status: statusLetter(y) });
    } else if (kind === 'u') {
      const fields = line.split(' ');
      st.conflicted.push({ path: fields.slice(10).join(' '), status: 'U', conflict: fields[1] });
    } else if (kind === '?') {
      st.untracked.push({ path: line.slice(2), status: '?' });
    }
  }
  return st;
}

/** Undo git's C-style quoting of a path ("a\tb" → a<TAB>b, octal escapes → UTF-8). */
export function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string | null {
  const u = unquotePath(p.replace(/\t$/, ''));
  if (u === '/dev/null') return null;
  return u.replace(/^[ab]\//, '');
}

const MAX_DIFF_LINES = 30000;

/** Parses unified diff output produced by `git diff` / `git show`. */
export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = out.split('\n');
  let file: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let lineCount = 0;

  const finish = () => {
    if (!file) return;
    if (file.status === 'M') {
      if (file.oldPath === null) file.status = 'A';
      else if (file.newPath === null) file.status = 'D';
    }
    files.push(file);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      finish();
      hunk = null;
      lineCount = 0;
      file = { oldPath: null, newPath: null, status: 'M', binary: false, hunks: [] };
      // Fallback paths for diffs without ---/+++ lines (pure renames, mode changes, empty files).
      const rest = line.replace(/^diff --git /, '');
      const m = /^("?a\/.*"?) ("?b\/.*"?)$/.exec(rest);
      if (m) {
        const a = unquotePath(m[1]).slice(2);
        const b = unquotePath(m[2]).slice(2);
        file.oldPath = a;
        file.newPath = b;
      }
      continue;
    }
    if (!file) continue;
    if (hunk) {
      if (line.startsWith('\\')) {
        hunk.lines.push({ t: 'meta', s: line.slice(2) });
        continue;
      }
      const done = oldNo >= hunk.oldStart + hunk.oldLines && newNo >= hunk.newStart + hunk.newLines;
      const c = line[0];
      if (!done && (c === ' ' || c === '+' || c === '-' || line === '')) {
        if (lineCount++ > MAX_DIFF_LINES) {
          file.truncated = true;
          if (c !== '+') oldNo++;
          if (c !== '-') newNo++;
          continue;
        }
        let dl: DiffLine;
        if (c === '+') dl = { t: 'add', s: line.slice(1), n: newNo++ };
        else if (c === '-') dl = { t: 'del', s: line.slice(1), o: oldNo++ };
        else dl = { t: 'ctx', s: line.slice(1), o: oldNo++, n: newNo++ };
        hunk.lines.push(dl);
        continue;
      }
      hunk = null;
    }
    const hm = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/.exec(line);
    if (hm) {
      hunk = {
        header: hm[5] ?? '',
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ')) {
      file.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      file.newPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('new file mode ')) {
      file.status = 'A';
      file.newMode = line.slice(14);
      file.oldPath = null;
    } else if (line.startsWith('deleted file mode ')) {
      file.status = 'D';
      file.oldMode = line.slice(18);
      file.newPath = null;
    } else if (line.startsWith('old mode ')) {
      file.oldMode = line.slice(9);
    } else if (line.startsWith('new mode ')) {
      file.newMode = line.slice(9);
    } else if (line.startsWith('rename from ')) {
      file.status = 'R';
      file.oldPath = unquotePath(line.slice(12));
    } else if (line.startsWith('rename to ')) {
      file.newPath = unquotePath(line.slice(10));
    } else if (line.startsWith('copy from ')) {
      file.status = 'C';
      file.oldPath = unquotePath(line.slice(10));
    } else if (line.startsWith('copy to ')) {
      file.newPath = unquotePath(line.slice(8));
    } else if (line.startsWith('similarity index ')) {
      file.similarity = parseInt(line.slice(17), 10);
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
    }
  }
  finish();
  return files;
}

/** Parses `git blame --porcelain`. */
export function parseBlame(out: string, path: string, rev: string | null): BlameResult {
  const lines: BlameLine[] = [];
  const commits: Record<string, BlameCommit> = {};
  const rows = out.split('\n');
  let cur: { hash: string; orig: number; final: number } | null = null;
  for (const row of rows) {
    if (cur === null) {
      const m = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(row);
      if (!m) continue;
      cur = { hash: m[1], orig: Number(m[2]), final: Number(m[3]) };
      if (!commits[cur.hash]) {
        commits[cur.hash] = { hash: cur.hash, author: '', authorEmail: '', authorTime: 0, summary: '', filename: path };
      }
      continue;
    }
    if (row.startsWith('\t')) {
      lines.push({ hash: cur.hash, origLine: cur.orig, line: cur.final, content: row.slice(1) });
      cur = null;
      continue;
    }
    const c = commits[cur.hash];
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const val = sp < 0 ? '' : row.slice(sp + 1);
    if (key === 'author') c.author = val;
    else if (key === 'author-mail') c.authorEmail = val.replace(/^<|>$/g, '');
    else if (key === 'author-time') c.authorTime = Number(val);
    else if (key === 'summary') c.summary = val;
    else if (key === 'previous') c.previous = val.split(' ')[0];
    else if (key === 'filename') c.filename = val;
  }
  return { path, rev, lines, commits };
}
