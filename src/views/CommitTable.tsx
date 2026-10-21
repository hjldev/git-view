import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Commit } from '../../shared/types';
import { cx, formatDate, formatFullDate, shortHash } from '../util';
import type { GraphEdge, GraphRow } from './graph';
import { RefBadges } from './RefBadges';

export const ROW_H = 26;
const LANE_W = 14;
const PAD = 6;

const X = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;
const Y = (y: 0 | 1 | 2) => (y === 0 ? 0 : y === 1 ? ROW_H / 2 : ROW_H);

function edgePath(e: GraphEdge): string {
  const x1 = X(e.x1);
  const x2 = X(e.x2);
  const y1 = Y(e.y1);
  const y2 = Y(e.y2);
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

const GraphCell = memo(function GraphCell({ row, head, merge }: { row: GraphRow; head: boolean; merge: boolean }) {
  const w = PAD * 2 + row.width * LANE_W;
  return (
    <svg className="graph" width={w} height={ROW_H}>
      {row.edges.map((e, i) => (
        <path key={i} d={edgePath(e)} className={`g-stroke g${e.color}`} />
      ))}
      {head && <circle cx={X(row.lane)} cy={ROW_H / 2} r={6.5} className={`g-ring g${row.color}`} />}
      <circle cx={X(row.lane)} cy={ROW_H / 2} r={merge ? 3 : 4} className={cx(`g-fill g${row.color}`, merge && 'g-merge')} />
    </svg>
  );
});

export interface CommitTableProps {
  commits: Commit[];
  graph: GraphRow[];
  headHash: string | null;
  headBranch: string | null;
  selected: Set<string>;
  primary: string | null;
  onSelect: (selected: Set<string>, primary: string) => void;
  onContextMenu: (e: React.MouseEvent, commit: Commit) => void;
  onActivate?: (commit: Commit) => void;
  onNearEnd?: () => void;
  scrollToIndex?: { index: number; seq: number } | null;
  highlight?: string;
}

export function CommitTable(p: CommitTableProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const anchor = useRef<number>(-1);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const ensureVisible = (index: number, center = false) => {
    const el = ref.current;
    if (!el) return;
    const top = index * ROW_H;
    if (center) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H);
    } else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  useEffect(() => {
    if (p.scrollToIndex && p.scrollToIndex.index >= 0) ensureVisible(p.scrollToIndex.index, true);
  }, [p.scrollToIndex?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = p.commits.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + 8);

  useEffect(() => {
    if (last >= total - 30 && total > 0) p.onNearEnd?.();
  }, [last, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const clickRow = (e: React.MouseEvent, index: number) => {
    const c = p.commits[index];
    let next: Set<string>;
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      next = new Set(p.commits.slice(a, b + 1).map((x) => x.hash));
    } else if (e.metaKey || e.ctrlKey) {
      next = new Set(p.selected);
      if (next.has(c.hash) && next.size > 1) next.delete(c.hash);
      else next.add(c.hash);
      anchor.current = index;
    } else {
      next = new Set([c.hash]);
      anchor.current = index;
    }
    p.onSelect(next, c.hash);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = p.commits.findIndex((c) => c.hash === p.primary);
    const page = Math.max(1, Math.floor(height / ROW_H) - 1);
    let next = idx;
    if (e.key === 'ArrowDown') next = Math.min(total - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    else if (e.key === 'PageDown') next = Math.min(total - 1, idx + page);
    else if (e.key === 'PageUp') next = Math.max(0, idx - page);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = total - 1;
    else if (e.key === 'Enter' && idx >= 0) {
      p.onActivate?.(p.commits[idx]);
      return;
    } else return;
    e.preventDefault();
    if (next < 0 || next === idx) return;
    const c = p.commits[next];
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, next), Math.max(anchor.current, next)];
      p.onSelect(new Set(p.commits.slice(a, b + 1).map((x) => x.hash)), c.hash);
    } else {
      anchor.current = next;
      p.onSelect(new Set([c.hash]), c.hash);
    }
    ensureVisible(next);
  };

  const rows = [];
  for (let i = first; i < last; i++) {
    const c = p.commits[i];
    const g = p.graph[i];
    const isHead = c.hash === p.headHash;
    const sel = p.selected.has(c.hash);
    rows.push(
      <div
        key={c.hash}
        className={cx('ct-row', sel && 'selected', isHead && 'is-head', i % 2 === 1 && 'odd')}
        style={{ top: i * ROW_H }}
        onMouseDown={(e) => {
          if (e.button === 0) clickRow(e, i);
        }}
        onDoubleClick={() => p.onActivate?.(c)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!p.selected.has(c.hash)) {
            anchor.current = i;
            p.onSelect(new Set([c.hash]), c.hash);
          }
          p.onContextMenu(e, c);
        }}
      >
        <div className="ct-subject">
          {g && <GraphCell row={g} head={isHead} merge={c.parents.length > 1} />}
          <RefBadges refs={c.refs} headBranch={p.headBranch} />
          <span className="ellipsis" title={c.subject}>
            {c.subject}
          </span>
        </div>
        <div className="ct-author ellipsis" title={`${c.authorName} <${c.authorEmail}>`}>
          {c.authorName}
        </div>
        <div className="ct-date nowrap" title={formatFullDate(c.authorDate)}>
          {formatDate(c.authorDate)}
        </div>
        <div className="ct-hash mono">{shortHash(c.hash)}</div>
      </div>,
    );
  }

  return (
    <div className="commit-table">
      <div className="ct-header">
        <div className="ct-subject">提交</div>
        <div className="ct-author">作者</div>
        <div className="ct-date">日期</div>
        <div className="ct-hash">哈希</div>
      </div>
      <div
        ref={ref}
        className="ct-body"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div style={{ height: total * ROW_H, position: 'relative' }}>{rows}</div>
      </div>
    </div>
  );
}
