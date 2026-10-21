import { useEffect, useMemo, useState } from 'react';
import { Copy, FolderTree, History, List, ScanText } from 'lucide-react';
import type { CommitDetail, DiffSpec } from '../../shared/types';
import { api } from '../api';
import { openDiff, openTab, revealCommit } from '../actions';
import { app, usePref } from '../store';
import { showMenu } from '../ui/ContextMenu';
import { Split } from '../ui/Split';
import { toast } from '../ui/Toasts';
import { colorFor, copyText, cx, formatFullDate, initials, shortHash } from '../util';
import { displayOrder, FileTree, type TreeItem } from './FileTree';
import { RefBadges } from './RefBadges';

export function CommitDetails(props: {
  hash: string | null;
  count: number;
  onPreview: (spec: DiffSpec | null, specs: DiffSpec[], index: number) => void;
  previewPath: string | null;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grouped, setGrouped] = usePref('details.grouped', true);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    setBranches(null);
    if (!props.hash) {
      setDetail(null);
      return;
    }
    let alive = true;
    setError(null);
    api
      .commit(props.hash)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [props.hash]);

  const items: TreeItem[] = useMemo(
    () =>
      (detail?.files ?? []).map((f) => ({
        key: f.path,
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
    [detail],
  );

  if (!props.hash) return <div className="details empty-hint">选择一个提交以查看详情</div>;
  if (error) return <div className="details empty-hint c-error">{error}</div>;
  if (!detail || detail.hash !== props.hash) return <div className="details empty-hint muted loading">正在加载…</div>;

  // Navigation follows the order shown in the tree.
  const ordered = displayOrder(items, grouped);
  const specs: DiffSpec[] = ordered.map((f) => ({ kind: 'commit', hash: detail.hash, path: f.path, oldPath: f.oldPath }));
  const indexOf = (it: TreeItem) => ordered.findIndex((x) => x.key === it.key);
  const selected = new Set(props.previewPath ? [props.previewPath] : []);
  const headBranch = app.get().info?.head ?? null;

  const fileMenu = (it: TreeItem, e: React.MouseEvent) =>
    showMenu(e, [
      { label: '显示差异', hint: '双击', onClick: () => openDiff(specs, indexOf(it), false) },
      { label: '显示历史', icon: <History size={14} />, onClick: () => openTab({ type: 'history', path: it.path }) },
      { label: '注解（Blame）', icon: <ScanText size={14} />, onClick: () => openTab({ type: 'blame', path: it.path, rev: detail.hash }) },
      {
        label: '与本地比较',
        onClick: () => openDiff([{ kind: 'worktree-vs-ref', ref: detail.hash, path: it.path }], 0, false),
      },
      'sep',
      { label: '复制路径', icon: <Copy size={14} />, onClick: () => copyText(it.path) },
    ]);

  const totalAdd = detail.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const totalDel = detail.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="details">
      <Split
        id="details.v"
        dir="v"
        initial={300}
        min={80}
        first={
          <div className="panel">
            <div className="panel-toolbar">
              <span className="small muted nowrap">
                {detail.files.length} 个文件 <span className="c-add">+{totalAdd}</span> <span className="c-del">−{totalDel}</span>
              </span>
              {detail.parents.length > 1 && <span className="badge small" title="显示与第一个父提交的差异">合并提交</span>}
              <span className="spacer" />
              <button className={cx('icon-btn', grouped && 'active')} title="按目录分组" onClick={() => setGrouped(true)}>
                <FolderTree size={14} />
              </button>
              <button className={cx('icon-btn', !grouped && 'active')} title="平铺" onClick={() => setGrouped(false)}>
                <List size={14} />
              </button>
            </div>
            <div className="panel-body tree">
              {detail.files.length === 0 && <div className="muted pad">没有文件更改</div>}
              <FileTree
                items={items}
                grouped={grouped}
                selected={selected}
                showStats
                onSelect={(it) => props.onPreview(specs[indexOf(it)], specs, indexOf(it))}
                onOpen={(it) => openDiff(specs, indexOf(it), false)}
                onContextMenu={fileMenu}
              />
            </div>
          </div>
        }
        second={
          <div className="panel-body commit-message">
            <div className="msg-subject">{detail.subject}</div>
            {detail.body && <pre className="msg-body">{detail.body}</pre>}
            <div className="msg-meta">
              <div className="author-line">
                <span className="avatar" style={{ background: colorFor(detail.authorEmail) }}>
                  {initials(detail.authorName)}
                </span>
                <div>
                  <div>
                    <b>{detail.authorName}</b> <span className="muted">&lt;{detail.authorEmail}&gt;</span>
                  </div>
                  <div className="muted small">{formatFullDate(detail.authorDate)}</div>
                </div>
              </div>
              {(detail.committerName !== detail.authorName || detail.committerDate !== detail.authorDate) && (
                <div className="muted small">
                  由 {detail.committerName} 提交于 {formatFullDate(detail.committerDate)}
                </div>
              )}
              <div className="hash-line">
                <code className="mono">{detail.hash}</code>
                <button
                  className="icon-btn"
                  title="复制哈希"
                  onClick={() => {
                    void copyText(detail.hash);
                    toast({ type: 'info', title: '已复制提交哈希' });
                  }}
                >
                  <Copy size={13} />
                </button>
              </div>
              {detail.parents.length > 0 && (
                <div className="small">
                  <span className="muted">父提交 </span>
                  {detail.parents.map((p) => (
                    <button key={p} className="link-btn mono" onClick={() => revealCommit(p)}>
                      {shortHash(p)}
                    </button>
                  ))}
                </div>
              )}
              {detail.refs.length > 0 && (
                <div>
                  <RefBadges refs={detail.refs} headBranch={headBranch} max={20} />
                </div>
              )}
              <div className="small">
                {branches ? (
                  <>
                    <span className="muted">包含于 {branches.length} 个分支：</span>
                    <span className="contained">{branches.join(', ') || '无'}</span>
                  </>
                ) : (
                  <button
                    className="link-btn"
                    disabled={loadingBranches}
                    onClick={() => {
                      setLoadingBranches(true);
                      api
                        .commitBranches(detail.hash)
                        .then(setBranches)
                        .finally(() => setLoadingBranches(false));
                    }}
                  >
                    {loadingBranches ? '正在查找…' : '显示包含此提交的分支'}
                  </button>
                )}
              </div>
              {props.count > 1 && <div className="muted small">已选择 {props.count} 个提交</div>}
            </div>
          </div>
        }
      />
    </div>
  );
}
