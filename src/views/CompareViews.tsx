import { useEffect, useMemo, useState } from 'react';
import { FolderTree, GitCommitHorizontal, List } from 'lucide-react';
import type { ChangedFile, Commit, DiffSpec } from '../../shared/types';
import { api } from '../api';
import { cherryPick, openTab, revealCommit } from '../actions';
import { usePref } from '../store';
import { showMenu } from '../ui/ContextMenu';
import { Split } from '../ui/Split';
import { cx, formatDate, shortHash } from '../util';
import { DiffView } from './DiffView';
import { FileTree, type TreeItem } from './FileTree';

function CommitList({ title, commits }: { title: string; commits: Commit[] }) {
  return (
    <div className="compare-col">
      <div className="panel-toolbar">
        <b className="small">{title}</b>
        <span className="spacer" />
        <span className="muted small">{commits.length} 个提交</span>
      </div>
      <div className="panel-body">
        {commits.length === 0 && <div className="muted pad">没有提交</div>}
        {commits.map((c) => (
          <div
            key={c.hash}
            className="history-row"
            onDoubleClick={() => revealCommit(c.hash)}
            onContextMenu={(e) =>
              showMenu(e, [
                { label: '在日志中显示', onClick: () => revealCommit(c.hash) },
                { label: '优选', onClick: () => cherryPick([c.hash]) },
              ])
            }
          >
            <GitCommitHorizontal size={13} className="muted" />
            <span className="ellipsis grow">{c.subject}</span>
            <span className="muted ellipsis author">{c.authorName}</span>
            <span className="muted nowrap date">{formatDate(c.authorDate)}</span>
            <code className="mono muted small">{shortHash(c.hash)}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CompareView({ a, b }: { a: string; b: string }) {
  const [data, setData] = useState<{ onlyA: Commit[]; onlyB: Commit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.compare(a, b).then(setData).catch((e) => setError(e.message));
  }, [a, b]);
  if (error) return <div className="diff-msg c-error">{error}</div>;
  if (!data) return <div className="diff-msg muted">正在比较…</div>;
  return (
    <div className="compare-view">
      <div className="diff-toolbar">
        <span>
          比较 <b>{a}</b> 与 <b>{b}</b>
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={() => openTab({ type: 'compareFiles', from: b, to: a })}>
          显示文件差异
        </button>
      </div>
      <Split
        id="compare.h"
        dir="h"
        initial={520}
        first={<CommitList title={`在 ${a} 中但不在 ${b} 中`} commits={data.onlyA} />}
        second={<CommitList title={`在 ${b} 中但不在 ${a} 中`} commits={data.onlyB} />}
      />
    </div>
  );
}

export function CompareFilesView({ from, to }: { from: string; to: string }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [grouped, setGrouped] = usePref('compare.grouped', true);
  useEffect(() => {
    api
      .diffFiles(from, to)
      .then((f) => {
        setFiles(f);
        setSel(f[0]?.path ?? null);
      })
      .catch((e) => setError(e.message));
  }, [from, to]);
  const items: TreeItem[] = useMemo(
    () => (files ?? []).map((f) => ({ key: f.path, path: f.path, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions })),
    [files],
  );
  if (error) return <div className="diff-msg c-error">{error}</div>;
  if (!files) return <div className="diff-msg muted">正在比较…</div>;
  const cur = files.find((f) => f.path === sel);
  const spec: DiffSpec | null = cur
    ? to === 'WORKTREE'
      ? { kind: 'worktree-vs-ref', ref: from, path: cur.path }
      : { kind: 'refs', from, to, path: cur.path, oldPath: cur.oldPath }
    : null;
  return (
    <Split
      id="compareFiles.h"
      dir="h"
      initial={300}
      first={
        <div className="panel">
          <div className="panel-toolbar">
            <span className="small ellipsis">
              {from.length === 40 ? shortHash(from) : from} → {to === 'WORKTREE' ? '本地工作区' : to.length === 40 ? shortHash(to) : to}
            </span>
            <span className="spacer" />
            <button className={cx('icon-btn', grouped && 'active')} onClick={() => setGrouped(!grouped)} title="按目录分组">
              {grouped ? <FolderTree size={14} /> : <List size={14} />}
            </button>
          </div>
          <div className="panel-body tree">
            {files.length === 0 && <div className="muted pad">没有差异</div>}
            <FileTree items={items} grouped={grouped} selected={new Set(sel ? [sel] : [])} showStats onSelect={(it) => setSel(it.path)} />
          </div>
        </div>
      }
      second={spec ? <DiffView spec={spec} compact /> : <div className="empty-hint">选择文件查看差异</div>}
    />
  );
}
