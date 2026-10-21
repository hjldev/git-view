import type { DiffLine, FileDiff } from '../../shared/types';

export const CONTEXT = 3;

// ---------------------------------------------------------------------------
// Word level diff

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/**
 * Returns the changed character ranges of `a` and `b` using an LCS over
 * tokens. Returns null when the lines are too different to be useful.
 */
export function wordDiff(a: string, b: string): { a: [number, number][]; b: [number, number][] } | null {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > 300 || tb.length > 300 || !ta.length || !tb.length) return null;
  const n = ta.length;
  const m = tb.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
      common += ta[i - 1].trim() ? ta[i - 1].length : 0;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const meaningful = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length);
  if (meaningful > 0 && common / meaningful < 0.25) return null;
  const ranges = (tokens: string[], keep: boolean[]) => {
    const r: [number, number][] = [];
    let pos = 0;
    tokens.forEach((t, k) => {
      if (!keep[k]) {
        const last = r[r.length - 1];
        if (last && last[1] === pos) last[1] = pos + t.length;
        else r.push([pos, pos + t.length]);
      }
      pos += t.length;
    });
    return r;
  };
  return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
}

// ---------------------------------------------------------------------------
// Rows

export interface Side {
  no: number;
  text: string;
  type: 'ctx' | 'add' | 'del';
  words?: [number, number][];
}

export type Row =
  | { kind: 'split'; left?: Side; right?: Side; block?: number; blockStart?: boolean; bk?: BlockKind }
  | { kind: 'unified'; side: Side; old?: number; new?: number; block?: number; blockStart?: boolean; bk?: BlockKind }
  | { kind: 'fold'; key: string; count: number; seg: number }
  | { kind: 'gap'; header: string }
  | { kind: 'meta'; text: string };

/** IDEA colors blocks by kind: modified (blue), inserted (green), deleted (gray). */
export type BlockKind = 'mod' | 'add' | 'del';

export interface ChangeBlock {
  /** Index range [start, end) into the flattened line list. */
  start: number;
  end: number;
  adds: number;
  dels: number;
}

interface Flat {
  lines: DiffLine[];
  /** index of the first line of every hunk (except the first) */
  hunkStarts: Map<number, string>;
}

export function flatten(file: FileDiff): Flat {
  const lines: DiffLine[] = [];
  const hunkStarts = new Map<number, string>();
  file.hunks.forEach((h, i) => {
    if (i > 0 || h.oldStart > 1 || h.newStart > 1) hunkStarts.set(lines.length, h.header);
    lines.push(...h.lines);
  });
  return { lines, hunkStarts };
}

export function changeBlocks(lines: DiffLine[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  lines.forEach((l, i) => {
    if (l.t === 'add' || l.t === 'del' || (l.t === 'meta' && cur)) {
      if (!cur) cur = { start: i, end: i + 1, adds: 0, dels: 0 };
      cur.end = i + 1;
      if (l.t === 'add') cur.adds++;
      if (l.t === 'del') cur.dels++;
    } else if (cur) {
      blocks.push(cur);
      cur = null;
    }
  });
  if (cur) blocks.push(cur);
  return blocks;
}

/**
 * Builds the visible rows for a file, folding long unchanged regions unless
 * they were expanded (`expanded` holds fold keys).
 */
export function buildRows(
  file: FileDiff,
  mode: 'split' | 'unified',
  collapse: boolean,
  expanded: Set<string>,
): { rows: Row[]; blocks: ChangeBlock[] } {
  const { lines, hunkStarts } = flatten(file);
  const blocks = changeBlocks(lines);
  const blockAt = new Map<number, number>();
  blocks.forEach((b, i) => blockAt.set(b.start, i));
  const rows: Row[] = [];
  let i = 0;
  let seg = 0;
  while (i < lines.length) {
    if (hunkStarts.has(i)) rows.push({ kind: 'gap', header: hunkStarts.get(i)! });
    const bi = blockAt.get(i);
    if (bi !== undefined) {
      const b = blocks[bi];
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      const metas: string[] = [];
      for (let k = b.start; k < b.end; k++) {
        const l = lines[k];
        if (l.t === 'del') dels.push(l);
        else if (l.t === 'add') adds.push(l);
        else if (l.t === 'meta') metas.push(l.s);
      }
      const pairs = Math.min(dels.length, adds.length);
      const words: ({ a: [number, number][]; b: [number, number][] } | null)[] = [];
      for (let k = 0; k < pairs; k++) words.push(dels.length + adds.length < 400 ? wordDiff(dels[k].s, adds[k].s) : null);
      let first = true;
      const bk: BlockKind = dels.length && adds.length ? 'mod' : adds.length ? 'add' : 'del';
      if (mode === 'split') {
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
          const d = dels[k];
          const a = adds[k];
          rows.push({
            kind: 'split',
            left: d ? { no: d.o!, text: d.s, type: 'del', words: words[k]?.a } : undefined,
            right: a ? { no: a.n!, text: a.s, type: 'add', words: words[k]?.b } : undefined,
            block: bi,
            blockStart: first,
            bk,
          });
          first = false;
        }
      } else {
        dels.forEach((d, k) => {
          rows.push({ kind: 'unified', side: { no: d.o!, text: d.s, type: 'del', words: words[k]?.a }, old: d.o, block: bi, blockStart: first, bk });
          first = false;
        });
        adds.forEach((a, k) => {
          rows.push({ kind: 'unified', side: { no: a.n!, text: a.s, type: 'add', words: words[k]?.b }, new: a.n, block: bi, blockStart: first, bk });
          first = false;
        });
      }
      for (const m of metas) rows.push({ kind: 'meta', text: m });
      i = b.end;
      continue;
    }
    // Context run until the next block / hunk start.
    let j = i;
    while (j < lines.length && lines[j].t === 'ctx' && (j === i || !hunkStarts.has(j))) j++;
    if (j === i) {
      // stray meta line
      rows.push({ kind: 'meta', text: lines[i].s });
      i++;
      continue;
    }
    const run = lines.slice(i, j);
    const atStart = i === 0 || hunkStarts.has(i);
    const atEnd = j >= lines.length || hunkStarts.has(j);
    const keepHead = atStart ? 0 : CONTEXT;
    const keepTail = atEnd ? 0 : CONTEXT;
    const key = `${seg}:${run[0].o}`;
    const pushCtx = (l: DiffLine) =>
      rows.push(
        mode === 'split'
          ? { kind: 'split', left: { no: l.o!, text: l.s, type: 'ctx' }, right: { no: l.n!, text: l.s, type: 'ctx' } }
          : { kind: 'unified', side: { no: l.n!, text: l.s, type: 'ctx' }, old: l.o, new: l.n },
      );
    if (collapse && run.length > keepHead + keepTail + 2 && !expanded.has(key)) {
      run.slice(0, keepHead).forEach(pushCtx);
      rows.push({ kind: 'fold', key, count: run.length - keepHead - keepTail, seg });
      run.slice(run.length - keepTail).forEach(pushCtx);
    } else {
      run.forEach(pushCtx);
    }
    seg++;
    i = j;
  }
  return { rows, blocks };
}

// ---------------------------------------------------------------------------
// Partial staging

const quote = (p: string) => (/[\s"\\]/.test(p) ? JSON.stringify(p) : p);

/** Creates a patch containing a single change block with up to 3 context lines. */
export function blockPatch(file: FileDiff, block: ChangeBlock): string {
  const { lines } = flatten(file);
  let s = block.start;
  let ctxBefore = 0;
  while (s > 0 && lines[s - 1].t === 'ctx' && ctxBefore < CONTEXT) {
    s--;
    ctxBefore++;
  }
  let e = block.end;
  let ctxAfter = 0;
  while (e < lines.length && (lines[e].t === 'ctx' || (lines[e].t === 'meta' && ctxAfter > 0)) && ctxAfter < CONTEXT) {
    if (lines[e].t === 'ctx') ctxAfter++;
    e++;
  }
  if (e < lines.length && lines[e].t === 'meta') e++;
  const part = lines.slice(s, e);
  const oldCount = part.filter((l) => l.t === 'ctx' || l.t === 'del').length;
  const newCount = part.filter((l) => l.t === 'ctx' || l.t === 'add').length;
  const firstOld = part.find((l) => l.o !== undefined)?.o;
  const firstNew = part.find((l) => l.n !== undefined)?.n;
  const oldStart = oldCount === 0 ? (firstNew ?? 1) - 1 : firstOld ?? 0;
  const newStart = newCount === 0 ? (firstOld ?? 1) - 1 : firstNew ?? 0;
  const oldPath = file.oldPath ?? file.newPath!;
  const newPath = file.newPath ?? file.oldPath!;
  const body = part
    .map((l) => (l.t === 'ctx' ? ' ' : l.t === 'add' ? '+' : l.t === 'del' ? '-' : '\\ ') + l.s)
    .join('\n');
  return [
    `diff --git a/${quote(oldPath)} b/${quote(newPath)}`,
    `--- ${file.oldPath ? 'a/' + quote(file.oldPath) : '/dev/null'}`,
    `+++ ${file.newPath ? 'b/' + quote(file.newPath) : '/dev/null'}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    body,
    '',
  ].join('\n');
}
