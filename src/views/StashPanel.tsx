import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Package, PackageOpen, Plus, Trash2 } from 'lucide-react';
import type { ChangedFile, DiffSpec } from '../../shared/types';
import { api } from '../api';
import { openDiff, runOp } from '../actions';
import { stashDialog, validateBranchName } from '../dialogs/dialogs';
import { useApp } from '../store';
import { showMenu } from '../ui/ContextMenu';
import { confirmDialog, promptDialog } from '../ui/Dialog';
import { cx, formatDate } from '../util';
import { FileTree, type TreeItem } from './FileTree';

type StashFile = ChangedFile & { untracked?: boolean };

function StashFiles({ index, hash }: { index: number; hash: string }) {
  const [files, setFiles] = useState<StashFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.stashFiles(index).then(setFiles).catch(() => setFiles([]));
  }, [index, hash]);
  if (!files) return <div className="muted pad small">正在加载…</div>;
  const specs: DiffSpec[] = files.map((f) => ({ kind: 'stash', index, path: f.path, oldPath: f.oldPath, untracked: f.untracked }));
  const items: (TreeItem & { i: number })[] = files.map((f, i) => ({
    key: `${f.untracked ? 'u' : 't'}:${f.path}`,
    path: f.path,
    oldPath: f.oldPath,
    status: f.untracked ? '?' : f.status,
    additions: f.additions,
    deletions: f.deletions,
    i,
  }));
  return (
    <FileTree
      items={items}
      grouped={false}
      baseDepth={1}
      selected={selected}
      showStats
      onSelect={(it) => {
        setSelected(new Set([it.key]));
        openDiff(specs, it.i, true);
      }}
      onOpen={(it) => openDiff(specs, it.i, false)}
    />
  );
}

export function StashPanel() {
  const stashes = useApp((s) => s.stashes);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const apply = (index: number, pop: boolean) =>
    runOp(pop ? '弹出储藏' : '应用储藏', () => api.stashApply(index, pop), { success: pop ? '已弹出储藏' : '已应用储藏' });
  const drop = async (index: number, message: string) => {
    const ok = await confirmDialog({ title: '删除储藏', message: `确定要删除储藏 “${message}” 吗？`, okText: '删除', danger: true });
    if (ok) await runOp('删除储藏', () => api.stashDrop(index), { success: '已删除储藏' });
  };
  const branch = async (index: number) => {
    const name = await promptDialog({ title: '从储藏创建分支', label: '新分支名称', validate: validateBranchName, okText: '创建' });
    if (name) await runOp('从储藏创建分支', () => api.stashBranch(index, name), { success: `已创建分支 ${name}` });
  };

  return (
    <div className="panel stash-panel">
      <div className="panel-header">
        <span className="panel-title">储藏</span>
        <span className="spacer" />
        <button className="icon-btn" title="储藏更改…" onClick={() => stashDialog()}>
          <Plus size={14} />
        </button>
        <button
          className="icon-btn"
          title="清除所有储藏"
          disabled={!stashes.length}
          onClick={async () => {
            const ok = await confirmDialog({ title: '清除储藏', message: '确定要删除所有储藏吗？此操作无法撤销。', okText: '全部删除', danger: true });
            if (ok) await runOp('清除储藏', () => api.stashClear(), { success: '已清除所有储藏' });
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="panel-body tree">
        {stashes.length === 0 && (
          <div className="empty-hint">
            <Package size={28} className="muted" />
            <div>没有储藏</div>
            <button className="btn small" onClick={() => stashDialog()}>
              储藏更改…
            </button>
          </div>
        )}
        {stashes.map((s) => {
          const isOpen = open.has(s.hash);
          return (
            <div key={s.hash}>
              <div
                className={cx('tree-row stash-row', selected === s.hash && 'selected')}
                onClick={() => {
                  setSelected(s.hash);
                  const n = new Set(open);
                  if (n.has(s.hash)) n.delete(s.hash);
                  else n.add(s.hash);
                  setOpen(n);
                }}
                onContextMenu={(e) => {
                  setSelected(s.hash);
                  showMenu(e, [
                    { label: '应用', icon: <PackageOpen size={14} />, onClick: () => apply(s.index, false) },
                    { label: '弹出', onClick: () => apply(s.index, true) },
                    {
                      label: '应用并恢复暂存区',
                      onClick: () => runOp('应用储藏', () => api.stashApply(s.index, false, true), { success: '已应用储藏' }),
                    },
                    { label: '从储藏创建分支…', icon: <GitBranch size={14} />, onClick: () => branch(s.index) },
                    'sep',
                    { label: '删除', icon: <Trash2 size={14} />, danger: true, onClick: () => drop(s.index, s.message) },
                  ]);
                }}
              >
                <span className="tree-toggle">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                <Package size={14} className="muted" />
                <div className="stash-text">
                  <div className="ellipsis">{s.message}</div>
                  <div className="muted small ellipsis">
                    {s.ref} · {s.branch} · {formatDate(s.date)}
                  </div>
                </div>
                <span className="row-actions">
                  <button className="mini-btn wide" title="应用此储藏" onClick={(e) => (e.stopPropagation(), void apply(s.index, false))}>
                    应用
                  </button>
                  <button className="mini-btn wide" title="应用并删除此储藏" onClick={(e) => (e.stopPropagation(), void apply(s.index, true))}>
                    弹出
                  </button>
                </span>
              </div>
              {isOpen && <StashFiles index={s.index} hash={s.hash} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
