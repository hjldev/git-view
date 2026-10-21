import { useEffect, useState } from 'react';
import { Copy, Eye, ScanText } from 'lucide-react';
import type { Commit } from '../../shared/types';
import { api } from '../api';
import { openDiff, openTab, revealCommit } from '../actions';
import { showMenu } from '../ui/ContextMenu';
import { Split } from '../ui/Split';
import { copyText, cx, formatDate, formatFullDate, shortHash } from '../util';
import { DiffView } from './DiffView';

type Entry = Commit & { path: string; oldPath?: string; status: string };

export function FileHistoryView({ path }: { path: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    api
      .fileHistory(path)
      .then((e) => alive && (setEntries(e), setSel(0)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <div className="diff-msg c-error">{error}</div>;
  if (!entries) return <div className="diff-msg muted">正在加载历史…</div>;
  if (!entries.length) return <div className="diff-msg muted">没有找到该文件的提交历史</div>;
  const cur = entries[sel];

  return (
    <Split
      id="history.v"
      dir="v"
      initial={260}
      min={100}
      first={
        <div className="panel">
          <div className="panel-toolbar">
            <span className="mono small ellipsis">{path}</span>
            <span className="spacer" />
            <span className="muted small">{entries.length} 个提交</span>
          </div>
          <div
            className="panel-body history-list"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSel((s) => Math.min(entries.length - 1, s + 1));
              if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            }}
          >
            {entries.map((c, i) => (
              <div
                key={c.hash}
                className={cx('history-row', i === sel && 'selected')}
                onClick={() => setSel(i)}
                onDoubleClick={() => openDiff([{ kind: 'commit', hash: c.hash, path: c.path, oldPath: c.oldPath }], 0, false)}
                onContextMenu={(e) => {
                  setSel(i);
                  showMenu(e, [
                    { label: '在日志中显示', icon: <Eye size={14} />, onClick: () => revealCommit(c.hash) },
                    { label: '注解此修订', icon: <ScanText size={14} />, onClick: () => openTab({ type: 'blame', path: c.path, rev: c.hash }) },
                    {
                      label: '与本地比较',
                      onClick: () => openDiff([{ kind: 'worktree-vs-ref', ref: c.hash, path: c.path }], 0, false),
                    },
                    'sep',
                    { label: '复制修订号', icon: <Copy size={14} />, onClick: () => copyText(c.hash) },
                  ]);
                }}
              >
                <code className="mono muted">{shortHash(c.hash)}</code>
                <span className="ellipsis grow">
                  {c.subject}
                  {c.path !== path && <span className="muted small"> （{c.path}）</span>}
                </span>
                <span className="ellipsis muted author">{c.authorName}</span>
                <span className="nowrap muted date" title={formatFullDate(c.authorDate)}>
                  {formatDate(c.authorDate)}
                </span>
              </div>
            ))}
          </div>
        </div>
      }
      second={<DiffView spec={{ kind: 'commit', hash: cur.hash, path: cur.path, oldPath: cur.oldPath }} compact />}
    />
  );
}
