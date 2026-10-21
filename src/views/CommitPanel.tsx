import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  FileDiff,
  FolderTree,
  GitMerge,
  History,
  List,
  Minus,
  Package,
  Plus,
  RefreshCw,
  ScanText,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { ChangedFile, DiffSpec } from '../../shared/types';
import { api } from '../api';
import { openDiff, openTab, refreshAll, runOp, sequenceControl, showConflicts } from '../actions';
import { pushDialog, stashDialog } from '../dialogs/dialogs';
import { app, useApp, usePref } from '../store';
import { showMenu, type MenuEntry } from '../ui/ContextMenu';
import { confirmDialog } from '../ui/Dialog';
import { cx } from '../util';
import { displayOrder, FileTree, type TreeItem } from './FileTree';

type Group = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

interface Item extends TreeItem {
  group: Group;
}

const GROUP_LABEL: Record<Group, string> = {
  conflicted: '合并冲突',
  staged: '已暂存',
  unstaged: '更改',
  untracked: '未跟踪的文件',
};

function specFor(it: Item): DiffSpec | null {
  switch (it.group) {
    case 'staged':
      return { kind: 'staged', path: it.path, oldPath: it.oldPath };
    case 'unstaged':
      return { kind: 'unstaged', path: it.path };
    case 'untracked':
      return { kind: 'untracked', path: it.path };
    default:
      return null;
  }
}

const STATE_TEXT: Record<string, string> = {
  merging: '正在合并',
  rebasing: '正在变基',
  'cherry-picking': '正在优选',
  reverting: '正在还原',
  bisecting: '正在二分查找',
};

export function CommitPanel() {
  const status = useApp((s) => s.status);
  const info = useApp((s) => s.info);
  const message = useApp((s) => s.commitMessage);
  const amend = useApp((s) => s.amend);
  const [grouped, setGrouped] = usePref('changes.grouped', true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<Group>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const groups = useMemo(() => {
    const make = (g: Group, files: ChangedFile[]): Item[] =>
      files.map((f) => ({ key: `${g}:${f.path}`, path: f.path, oldPath: f.oldPath, status: f.status, group: g }));
    return {
      conflicted: make('conflicted', status?.conflicted ?? []),
      staged: make('staged', status?.staged ?? []),
      unstaged: make('unstaged', status?.unstaged ?? []),
      untracked: make('untracked', status?.untracked ?? []),
    };
  }, [status]);
  const all = useMemo(() => [...groups.conflicted, ...groups.staged, ...groups.unstaged, ...groups.untracked], [groups]);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);

  // Forget selections of files that disappeared.
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((k) => byKey.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [byKey]);

  const selItems = [...selected].map((k) => byKey.get(k)).filter((x): x is Item => !!x);
  const pathsOf = (items: Item[]) => [...new Set(items.map((i) => i.path))];

  const select = (it: Item, e: React.MouseEvent) => {
    let next: Set<string>;
    if (e.metaKey || e.ctrlKey) {
      next = new Set(selected);
      if (next.has(it.key)) next.delete(it.key);
      else next.add(it.key);
    } else if (e.shiftKey && selected.size) {
      const keys = all.map((i) => i.key);
      const last = keys.indexOf([...selected][selected.size - 1]);
      const cur = keys.indexOf(it.key);
      next = new Set(keys.slice(Math.min(last, cur), Math.max(last, cur) + 1));
    } else {
      next = new Set([it.key]);
      if (e.type === 'click') preview(it, true);
    }
    setSelected(next);
  };

  const preview = (it: Item, isPreview: boolean) => {
    if (it.group === 'conflicted') {
      if (!isPreview) openTab({ type: 'merge', path: it.path });
      return;
    }
    const list = displayOrder(groups[it.group], grouped);
    const specs = list.map(specFor).filter((s): s is DiffSpec => !!s);
    openDiff(specs, list.findIndex((x) => x.key === it.key), isPreview);
  };

  const stage = (items: Item[]) => runOp('暂存', () => api.stage(pathsOf(items)));
  const unstage = (items: Item[]) => runOp('取消暂存', () => api.unstage(pathsOf(items)));
  const rollback = async (items: Item[]) => {
    const unstagedOnly = items.every((i) => i.group === 'unstaged');
    const paths = pathsOf(items);
    const added = items.filter((i) => i.group === 'staged' && i.status === 'A');
    const r = await confirmDialog({
      title: '回滚更改',
      message: (
        <>
          <p>
            确定要回滚 {paths.length} 个文件的{unstagedOnly ? '未暂存' : '所有'}更改吗？此操作无法撤销。
          </p>
          <ul className="file-list">
            {paths.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {paths.length > 8 && <li>…</li>}
          </ul>
        </>
      ),
      okText: '回滚',
      danger: true,
      extra: added.length ? { label: '回滚并删除新增文件', value: 'delete' } : undefined,
    });
    if (!r) return;
    if (unstagedOnly) await runOp('回滚', () => api.discardUnstaged(paths), { success: '已回滚更改' });
    else await runOp('回滚', () => api.rollback(paths, r === 'delete'), { success: '已回滚更改' });
  };
  const deleteUntracked = async (items: Item[]) => {
    const paths = pathsOf(items);
    const ok = await confirmDialog({
      title: '删除文件',
      message: `确定要从磁盘删除 ${paths.length} 个未跟踪的文件吗？此操作无法撤销。`,
      okText: '删除',
      danger: true,
    });
    if (ok) await runOp('删除文件', () => api.deleteUntracked(paths), { success: '已删除' });
  };

  const fileMenu = (it: Item, e: React.MouseEvent) => {
    const items = selected.has(it.key) ? selItems : [it];
    const groupsSel = new Set(items.map((i) => i.group));
    const only = (g: Group) => groupsSel.size === 1 && groupsSel.has(g);
    const menu: MenuEntry[] = [
      only('conflicted') && { label: '解决冲突…', icon: <GitMerge size={14} />, onClick: () => showConflicts() },
      only('conflicted') && items.length === 1 && { label: '合并…', onClick: () => openTab({ type: 'merge', path: it.path }) },
      only('conflicted') && { label: '接受您的', onClick: () => runOp('接受您的版本', () => api.acceptConflict(pathsOf(items), 'ours')) },
      only('conflicted') && { label: '接受他们的', onClick: () => runOp('接受他们的版本', () => api.acceptConflict(pathsOf(items), 'theirs')) },
      only('conflicted') && { label: '标记为已解决', icon: <Check size={14} />, onClick: () => runOp('标记为已解决', () => api.markResolved(pathsOf(items))) },
      !groupsSel.has('conflicted') && { label: '显示差异', icon: <FileDiff size={14} />, hint: '双击', onClick: () => preview(it, false) },
      'sep',
      (groupsSel.has('unstaged') || groupsSel.has('untracked')) && {
        label: groupsSel.has('untracked') && groupsSel.size === 1 ? '添加到 VCS（暂存）' : '暂存',
        icon: <Plus size={14} />,
        onClick: () => stage(items.filter((i) => i.group !== 'staged')),
      },
      groupsSel.has('staged') && { label: '取消暂存', icon: <Minus size={14} />, onClick: () => unstage(items.filter((i) => i.group === 'staged')) },
      (groupsSel.has('staged') || groupsSel.has('unstaged')) && !groupsSel.has('untracked') && !groupsSel.has('conflicted') && {
        label: '回滚…',
        icon: <Undo2 size={14} />,
        onClick: () => rollback(items),
      },
      only('untracked') && { label: '删除…', icon: <Trash2 size={14} />, danger: true, onClick: () => deleteUntracked(items) },
      only('untracked') && {
        label: '添加到 .gitignore',
        icon: <EyeOff size={14} />,
        onClick: () => runOp('添加到 .gitignore', () => api.ignore(pathsOf(items)), { success: '已添加到 .gitignore' }),
      },
      'sep',
      !groupsSel.has('conflicted') && { label: '储藏选中文件…', icon: <Package size={14} />, onClick: () => stashDialog(pathsOf(items)) },
      'sep',
      items.length === 1 && it.group !== 'untracked' && { label: '显示历史', icon: <History size={14} />, onClick: () => openTab({ type: 'history', path: it.path }) },
      items.length === 1 && it.group !== 'untracked' && it.status !== 'A' && {
        label: '注解（Blame）',
        icon: <ScanText size={14} />,
        onClick: () => openTab({ type: 'blame', path: it.path }),
      },
      { label: '复制路径', icon: <Copy size={14} />, onClick: () => navigator.clipboard.writeText(pathsOf(items).join('\n')) },
    ];
    showMenu(e, menu);
  };

  const doCommit = async (andPush: boolean) => {
    const st = app.get().status;
    if (!st) return;
    const msg = app.get().commitMessage;
    if (!msg.trim() && !amend) {
      textRef.current?.focus();
      return;
    }
    if (st.conflicted.length) {
      await confirmDialog({ title: '无法提交', message: '存在未解决的冲突，请先解决冲突。', okText: '知道了' });
      return;
    }
    let all = false;
    if (!st.staged.length && !amend) {
      if (!st.unstaged.length && !st.untracked.length) {
        await confirmDialog({ title: '没有可提交的更改', message: '工作区没有任何更改。', okText: '知道了' });
        return;
      }
      const ok = await confirmDialog({
        title: '没有暂存的更改',
        message: '没有暂存的更改。是否暂存所有更改（包括未跟踪的文件）并提交？',
        okText: '全部暂存并提交',
      });
      if (!ok) return;
      all = true;
    }
    setBusy(true);
    try {
      if (all) {
        const s = await runOp('暂存', () => api.stageAll(), { refresh: false });
        if (!s?.ok) return;
      }
      const r = await runOp(amend ? '修改提交' : '提交', () => api.commitChanges({ message: msg, amend }), {
        success: amend ? '已修改上一次提交' : '提交成功',
      });
      if (r?.ok) {
        app.set({ commitMessage: '', amend: false });
        if (andPush) await pushDialog();
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleAmend = async (v: boolean) => {
    app.set({ amend: v });
    if (v && !app.get().commitMessage.trim()) {
      const last = await api.commitMessage('HEAD').catch(() => '');
      app.set({ commitMessage: last });
    }
  };

  const state = status?.state ?? 'clean';
  const total = all.length;

  const groupHeader = (g: Group, items: Item[]) => {
    const isCol = collapsedGroups.has(g);
    return (
      <div
        className="tree-row group-row"
        onClick={() => {
          const n = new Set(collapsedGroups);
          if (n.has(g)) n.delete(g);
          else n.add(g);
          setCollapsedGroups(n);
        }}
      >
        <span className="tree-toggle">{isCol ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
        <span className={cx('bold', g === 'conflicted' && 'c-error')}>{GROUP_LABEL[g]}</span>
        <span className="tree-count">{items.length} 个文件</span>
        <span className="spacer" />
        <span className="row-actions always" onClick={(e) => e.stopPropagation()}>
          {g === 'staged' && (
            <button className="mini-btn" title="全部取消暂存" onClick={() => runOp('取消暂存', () => api.unstageAll())}>
              <Minus size={12} />
            </button>
          )}
          {(g === 'unstaged' || g === 'untracked') && (
            <button className="mini-btn" title="全部暂存" onClick={() => stage(items)}>
              <Plus size={12} />
            </button>
          )}
          {g === 'unstaged' && (
            <button className="mini-btn" title="全部回滚" onClick={() => rollback(items)}>
              <Undo2 size={12} />
            </button>
          )}
          {g === 'conflicted' && (
            <button className="mini-btn wide" onClick={() => showConflicts()}>
              解决
            </button>
          )}
        </span>
      </div>
    );
  };

  const rowActions = (it: Item) => {
    if (it.group === 'staged')
      return (
        <button className="mini-btn" title="取消暂存" onClick={(e) => (e.stopPropagation(), void unstage([it]))}>
          <Minus size={12} />
        </button>
      );
    if (it.group === 'unstaged' || it.group === 'untracked')
      return (
        <>
          {it.group === 'unstaged' && (
            <button className="mini-btn" title="回滚" onClick={(e) => (e.stopPropagation(), void rollback([it]))}>
              <Undo2 size={12} />
            </button>
          )}
          <button className="mini-btn" title="暂存" onClick={(e) => (e.stopPropagation(), void stage([it]))}>
            <Plus size={12} />
          </button>
        </>
      );
    return (
      <button className="mini-btn wide" onClick={(e) => (e.stopPropagation(), openTab({ type: 'merge', path: it.path }))}>
        合并
      </button>
    );
  };

  return (
    <div className="panel commit-panel">
      <div className="panel-header">
        <span className="panel-title">提交</span>
        <span className="spacer" />
        <button className="icon-btn" title="刷新" onClick={() => refreshAll()}>
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-btn"
          title="回滚选中的更改"
          disabled={!selItems.some((i) => i.group === 'staged' || i.group === 'unstaged')}
          onClick={() => rollback(selItems.filter((i) => i.group === 'staged' || i.group === 'unstaged'))}
        >
          <Undo2 size={14} />
        </button>
        <button className="icon-btn" title="显示差异" disabled={!selItems.length} onClick={() => selItems[0] && preview(selItems[0], false)}>
          <FileDiff size={14} />
        </button>
        <button className="icon-btn" title="储藏更改…" disabled={!total} onClick={() => stashDialog()}>
          <Package size={14} />
        </button>
        <span className="tb-sep" />
        <button className={cx('icon-btn', grouped && 'active')} title="按目录分组" onClick={() => setGrouped(!grouped)}>
          {grouped ? <FolderTree size={14} /> : <List size={14} />}
        </button>
      </div>
      {state !== 'clean' && (
        <div className="state-banner">
          <div>
            <b>{STATE_TEXT[state]}</b>
            {status?.conflicted.length ? `，${status.conflicted.length} 个文件存在冲突` : '，冲突已全部解决'}
          </div>
          <div className="state-actions">
            {!!status?.conflicted.length && (
              <button className="btn small primary" onClick={() => showConflicts()}>
                解决冲突…
              </button>
            )}
            {!status?.conflicted.length && state !== 'bisecting' && (
              <button className="btn small primary" onClick={() => sequenceControl('continue')}>
                继续
              </button>
            )}
            {state === 'rebasing' && (
              <button className="btn small" onClick={() => sequenceControl('skip')}>
                跳过
              </button>
            )}
            {state !== 'bisecting' && (
              <button className="btn small" onClick={() => sequenceControl('abort')}>
                中止
              </button>
            )}
          </div>
        </div>
      )}
      <div className="panel-body tree changes-tree" tabIndex={0}>
        {!status && <div className="muted pad">正在加载…</div>}
        {status && total === 0 && <div className="empty-hint">没有更改</div>}
        {(['conflicted', 'staged', 'unstaged', 'untracked'] as Group[]).map((g) =>
          groups[g].length ? (
            <div key={g}>
              {groupHeader(g, groups[g])}
              {!collapsedGroups.has(g) && (
                <FileTree
                  items={groups[g]}
                  grouped={grouped}
                  keyPrefix={g}
                  baseDepth={1}
                  selected={selected}
                  onSelect={select}
                  onOpen={(it) => preview(it, false)}
                  onContextMenu={fileMenu}
                  renderActions={rowActions}
                />
              )}
            </div>
          ) : null,
        )}
      </div>
      <div className="commit-box">
        <textarea
          ref={textRef}
          className="commit-input"
          placeholder={`提交消息${info?.head ? `（${info.head}）` : ''}\n⌘/Ctrl + Enter 提交`}
          value={message}
          onChange={(e) => app.set({ commitMessage: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void doCommit(e.shiftKey);
            }
          }}
        />
        <div className="commit-actions">
          <label className="check" title="修改上一次提交（git commit --amend）">
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} />
            修改
          </label>
          <span className="spacer" />
          <button className="btn primary" disabled={busy} onClick={() => doCommit(false)}>
            {amend ? '修改提交' : '提交'}
          </button>
          <button className="btn" disabled={busy} title="提交并推送 (⌘⇧Enter)" onClick={() => doCommit(true)}>
            <ArrowUpFromLine size={13} /> 提交并推送…
          </button>
        </div>
        <div className="muted small commit-summary">
          {status && (
            <>
              已暂存 {status.staged.length} · 未暂存 {status.unstaged.length} · 未跟踪 {status.untracked.length}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
