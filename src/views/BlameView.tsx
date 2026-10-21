import { Fragment, useEffect, useMemo, useState } from 'react';
import { Copy, Eye, FileDiff, History } from 'lucide-react';
import type { BlameResult } from '../../shared/types';
import { api } from '../api';
import { openDiff, openTab, revealCommit } from '../actions';
import { showMenu } from '../ui/ContextMenu';
import { colorFor, copyText, cx, formatDate, formatFullDate, shortHash } from '../util';
import { highlightLines } from './highlight';

const UNCOMMITTED = /^0+$/;

export function BlameView({ path, rev }: { path: string; rev?: string }) {
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBlame(null);
    setError(null);
    api
      .blame(path, rev)
      .then((b) => alive && setBlame(b))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, rev]);

  const hl = useMemo(() => (blame ? highlightLines(blame.lines.map((l) => l.content).join('\n'), path) : null), [blame, path]);
  const range = useMemo(() => {
    if (!blame) return { min: 0, max: 1 };
    const times = Object.values(blame.commits)
      .map((c) => c.authorTime)
      .filter(Boolean);
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [blame]);

  if (error) return <div className="diff-msg c-error">{error}</div>;
  if (!blame) return <div className="diff-msg muted">正在计算注解…</div>;

  const age = (t: number) => (range.max === range.min ? 1 : (t - range.min) / (range.max - range.min));

  const menu = (e: React.MouseEvent, hash: string) => {
    const c = blame.commits[hash];
    if (UNCOMMITTED.test(hash)) return e.preventDefault();
    showMenu(e, [
      { header: `${shortHash(hash)} ${c.summary}` },
      { label: '在日志中显示', icon: <Eye size={14} />, onClick: () => revealCommit(hash) },
      {
        label: '显示此提交中的差异',
        icon: <FileDiff size={14} />,
        onClick: () => openDiff([{ kind: 'commit', hash, path: c.filename }], 0, false),
      },
      c.previous && {
        label: '注解上一修订',
        icon: <History size={14} />,
        onClick: () => openTab({ type: 'blame', path: c.filename, rev: c.previous }),
      },
      'sep',
      { label: '复制修订号', icon: <Copy size={14} />, onClick: () => copyText(hash) },
    ]);
  };

  return (
    <div className="blame-view">
      <div className="diff-toolbar">
        <span className="mono small ellipsis">{path}</span>
        {rev && <span className="badge small">{shortHash(rev)}</span>}
        <span className="spacer" />
        <span className="muted small">{Object.keys(blame.commits).length} 个提交 · {blame.lines.length} 行</span>
      </div>
      <div className="blame-body">
        {blame.lines.map((l, i) => {
          const c = blame.commits[l.hash];
          const first = i === 0 || blame.lines[i - 1].hash !== l.hash;
          const uncommitted = UNCOMMITTED.test(l.hash);
          const a = uncommitted ? 1 : age(c.authorTime);
          return (
            <div key={i} className={cx('blame-row', first && 'block-start', hover === l.hash && 'hover')}>
              <div
                className="blame-gutter"
                style={{ borderLeftColor: `color-mix(in srgb, var(--accent) ${Math.round(15 + a * 85)}%, transparent)` }}
                title={uncommitted ? '尚未提交的更改' : `${c.hash}\n${c.author} <${c.authorEmail}>\n${formatFullDate(c.authorTime)}\n\n${c.summary}`}
                onMouseEnter={() => setHover(l.hash)}
                onMouseLeave={() => setHover(null)}
                onClick={() => !uncommitted && revealCommit(l.hash)}
                onContextMenu={(e) => menu(e, l.hash)}
              >
                {first &&
                  (uncommitted ? (
                    <span className="muted">未提交</span>
                  ) : (
                    <>
                      <span className="blame-date">{formatDate(c.authorTime)}</span>
                      <span className="blame-author ellipsis" style={{ color: colorFor(c.authorEmail) }}>
                        {c.author}
                      </span>
                      <span className="blame-summary ellipsis muted">{c.summary}</span>
                    </>
                  ))}
              </div>
              <span className="ln">{l.line}</span>
              <span className="code">
                {hl?.[i]
                  ? hl[i].map((s, k) =>
                      s.cls ? (
                        <span key={k} className={s.cls}>
                          {s.text}
                        </span>
                      ) : (
                        <Fragment key={k}>{s.text}</Fragment>
                      ),
                    )
                  : l.content || '​'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
