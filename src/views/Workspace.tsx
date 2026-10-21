import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Cloud,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitMerge,
  History,
  LoaderCircle,
  Monitor,
  Moon,
  Package,
  Plus,
  RefreshCw,
  ScanText,
  Search,
  Server,
  Sun,
  Tag,
  X,
} from 'lucide-react';
import {
  closeRepo,
  closeTab,
  fetchAll,
  openRepo,
  pinTab,
  refreshAll,
  showConflicts,
  showError,
  updateTab,
} from '../actions';
import { api } from '../api';
import {
  checkoutRevisionDialog,
  newBranchDialog,
  pullDialog,
  pushDialog,
  remotesDialog,
  updateProject,
} from '../dialogs/dialogs';
import { localBranchMenu, remoteBranchMenu } from '../menus';
import { app, LOG_TAB, useApp, usePref, type Tab } from '../store';
import { showMenu, showMenuAt, type MenuEntry } from '../ui/ContextMenu';
import { Split } from '../ui/Split';
import { cx } from '../util';
import { BlameView } from './BlameView';
import { CommitPanel } from './CommitPanel';
import { CompareFilesView, CompareView } from './CompareViews';
import { DiffView } from './DiffView';
import { FileHistoryView } from './FileHistoryView';
import { LogView } from './LogView';
import { MergeView } from './MergeView';
import { StashPanel } from './StashPanel';

// ---------------------------------------------------------------------------
// Theme

export type Theme = 'dark' | 'light' | 'system';

export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Branch popup (IDEA "Git Branches" widget)

function BranchPopup({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const refs = useApp((s) => s.refs);
  const info = useApp((s) => s.info);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('.ctx-menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const query = q.trim().toLowerCase();
  const match = (n: string) => !query || n.toLowerCase().includes(query);
  const run = (fn: () => unknown) => () => {
    onClose();
    fn();
  };
  const actions = [
    { icon: <ArrowDownToLine size={14} />, label: '更新项目…', fn: () => updateProject() },
    { icon: <Check size={14} />, label: '提交…', fn: () => app.set({ leftPanel: 'commit' }) },
    { icon: <ArrowUpFromLine size={14} />, label: '推送…', fn: () => pushDialog() },
    { icon: <Plus size={14} />, label: '新建分支…', fn: () => newBranchDialog() },
    { icon: <Tag size={14} />, label: '签出标签或修订…', fn: () => checkoutRevisionDialog() },
  ].filter((a) => match(a.label));

  const local = (refs?.local ?? []).filter((b) => match(b.name));
  const remote = (refs?.remote ?? []).filter((b) => match(b.name));
  const branchItem = (name: string, isRemote: boolean, extra?: React.ReactNode, current = false) => (
    <div
      key={(isRemote ? 'r:' : 'l:') + name}
      className={cx('popup-item', current && 'current')}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu({ clientX: r.right - 4, clientY: r.top }, (isRemote ? remoteBranchMenu(name) : localBranchMenu(name)).map(
          (m): MenuEntry => (m && typeof m === 'object' && 'onClick' in m && m.onClick ? { ...m, onClick: run(m.onClick) } : m),
        ));
      }}
    >
      {isRemote ? <Cloud size={14} className="muted" /> : <GitBranch size={14} className={current ? 'c-accent' : 'muted'} />}
      <span className="ellipsis grow">{name}</span>
      {extra}
      <ChevronDown size={12} className="muted rot-90" />
    </div>
  );

  return (
    <div ref={ref} className="branch-popup" style={{ left: anchor.left, top: anchor.bottom + 4 }}>
      <div className="search-box">
        <Search size={13} className="muted" />
        <input autoFocus placeholder="搜索分支和操作" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="popup-scroll">
        {actions.map((a) => (
          <div key={a.label} className="popup-item" onClick={run(a.fn)}>
            {a.icon}
            <span>{a.label}</span>
          </div>
        ))}
        {local.length > 0 && <div className="popup-header">本地</div>}
        {local.map((b) =>
          branchItem(
            b.name,
            false,
            <span className="track small">
              {b.ahead > 0 && <span className="c-add">↑{b.ahead}</span>}
              {b.behind > 0 && <span className="c-accent">↓{b.behind}</span>}
              {b.upstream && <span className="muted">{b.upstream}</span>}
            </span>,
            b.name === info?.head,
          ),
        )}
        {remote.length > 0 && <div className="popup-header">远程</div>}
        {remote.map((b) => branchItem(b.name, true))}
        {!actions.length && !local.length && !remote.length && <div className="muted pad">没有匹配项</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar

function Toolbar() {
  const info = useApp((s) => s.info)!;
  const status = useApp((s) => s.status);
  const tasks = useApp((s) => s.tasks);
  const [popup, setPopup] = useState<DOMRect | null>(null);
  const [theme, setTheme] = usePref<Theme>('theme', 'dark');
  const busy = (t: string) => tasks.some((x) => x.title.startsWith(t));

  const repoMenu = async (el: HTMLElement) => {
    const recent = await api.recent().catch(() => []);
    showMenuAt(el, [
      { header: '最近的仓库' },
      ...recent.slice(0, 12).map(
        (r): MenuEntry => ({
          label: r.name,
          hint: r.path.replace(/^\/(Users|home)\/[^/]+/, '~'),
          checked: r.path === info.root,
          onClick: () => openRepo(r.path).catch((e) => showError('打开仓库失败', e)),
        }),
      ),
      'sep',
      { label: '管理远程仓库…', icon: <Server size={14} />, onClick: () => remotesDialog() },
      { label: '打开其他仓库…', icon: <FolderGit2 size={14} />, onClick: () => closeRepo() },
    ]);
  };

  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0;

  return (
    <div className="toolbar">
      <button className="widget" onClick={(e) => repoMenu(e.currentTarget)} title={info.root}>
        <span className="repo-icon">{info.name.slice(0, 2).toUpperCase()}</span>
        <b>{info.name}</b>
        <ChevronDown size={13} />
      </button>
      <button className="widget" onClick={(e) => setPopup(popup ? null : e.currentTarget.getBoundingClientRect())} title="Git 分支">
        <GitBranch size={15} />
        <span>{info.head ?? (info.headHash ? `${info.headHash.slice(0, 8)}（游离）` : '无提交')}</span>
        {(info.ahead > 0 || info.behind > 0) && (
          <span className="track small">
            {info.ahead > 0 && <span className="c-add">↑{info.ahead}</span>}
            {info.behind > 0 && <span className="c-accent">↓{info.behind}</span>}
          </span>
        )}
        <ChevronDown size={13} />
      </button>
      {info.state !== 'clean' && (
        <button className="widget warn" onClick={() => showConflicts()}>
          <GitMerge size={14} />
          {{ merging: '合并中', rebasing: '变基中', 'cherry-picking': '优选中', reverting: '还原中', bisecting: '二分中' }[info.state]}
        </button>
      )}
      <span className="spacer" />
      <button className="tb-btn" title="更新项目（拉取当前分支）" onClick={() => updateProject()} disabled={busy('更新')}>
        {busy('更新') ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
        <span>更新</span>
      </button>
      <button className="tb-btn" title="提交 (⌘K)" onClick={() => app.set({ leftPanel: 'commit' })}>
        <Check size={16} />
        <span>提交{changes ? ` (${changes})` : ''}</span>
      </button>
      <button className="tb-btn" title="推送… (⌘⇧K)" onClick={() => pushDialog()} disabled={busy('推送')}>
        {busy('推送') ? <LoaderCircle size={16} className="spin" /> : <ArrowUpFromLine size={16} />}
        <span>推送</span>
      </button>
      <span className="tb-sep" />
      <button className="tb-btn icon" title="获取所有远程仓库 (fetch)" onClick={() => fetchAll()} disabled={busy('获取')}>
        <RefreshCw size={16} className={cx(busy('获取') && 'spin')} />
      </button>
      <button className="tb-btn icon" title="拉取…" onClick={() => pullDialog()}>
        <GitCompare size={16} />
      </button>
      <span className="tb-sep" />
      <button
        className="tb-btn icon"
        title={`主题：${{ dark: '深色', light: '浅色', system: '跟随系统' }[theme]}`}
        onClick={() => {
          const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
          setTheme(next);
          applyTheme(next);
        }}
      >
        {theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}
      </button>
      {popup && <BranchPopup anchor={popup} onClose={() => setPopup(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool strip (left)

function ToolStrip() {
  const left = useApp((s) => s.leftPanel);
  const status = useApp((s) => s.status);
  const stashes = useApp((s) => s.stashes);
  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  const toggle = (p: 'commit' | 'stash') => {
    const next = left === p ? null : p;
    app.set({ leftPanel: next });
    localStorage.setItem('gv.leftPanel', next ?? '');
  };
  return (
    <div className="tool-strip">
      <button className={cx('strip-btn', left === 'commit' && 'active')} title="提交 (⌘K)" onClick={() => toggle('commit')}>
        <GitCommitHorizontal size={18} />
        {changes > 0 && <span className="strip-badge">{changes > 99 ? '99+' : changes}</span>}
      </button>
      <button className={cx('strip-btn', left === 'stash' && 'active')} title="储藏" onClick={() => toggle('stash')}>
        <Package size={18} />
        {stashes.length > 0 && <span className="strip-badge muted-badge">{stashes.length}</span>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor tabs

function tabIcon(t: Tab) {
  switch (t.view.type) {
    case 'diff':
      return <FileDiff size={13} />;
    case 'blame':
      return <ScanText size={13} />;
    case 'history':
      return <History size={13} />;
    case 'merge':
      return <GitMerge size={13} className="c-error" />;
    default:
      return <GitCompare size={13} />;
  }
}

function TabContent({ tab }: { tab: Tab }) {
  const v = tab.view;
  switch (v.type) {
    case 'diff':
      return (
        <DiffView
          spec={v.specs[v.index]}
          nav={
            v.specs.length > 1
              ? {
                  index: v.index,
                  total: v.specs.length,
                  prev: () => updateTab(tab.id, { ...v, index: v.index - 1 }),
                  next: () => updateTab(tab.id, { ...v, index: v.index + 1 }),
                }
              : undefined
          }
        />
      );
    case 'blame':
      return <BlameView path={v.path} rev={v.rev} />;
    case 'history':
      return <FileHistoryView path={v.path} />;
    case 'compare':
      return <CompareView a={v.a} b={v.b} />;
    case 'compareFiles':
      return <CompareFilesView from={v.from} to={v.to} />;
    case 'merge':
      return <MergeView path={v.path} tabId={tab.id} />;
  }
}

function EditorArea() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.activeTab);
  const activeTab = tabs.find((t) => t.id === active);
  return (
    <div className="editor-area">
      <div className="tabs-bar">
        <div className={cx('tab', active === LOG_TAB && 'active')} onClick={() => app.set({ activeTab: LOG_TAB })}>
          <GitBranch size={13} />
          <span>Git 日志</span>
        </div>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={cx('tab', active === t.id && 'active', t.preview && 'preview')}
            title={t.tooltip}
            onClick={() => app.set({ activeTab: t.id })}
            onDoubleClick={() => pinTab(t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            onContextMenu={(e) =>
              showMenu(e, [
                { label: '关闭', onClick: () => closeTab(t.id) },
                { label: '关闭其他标签页', onClick: () => app.set({ tabs: [t], activeTab: t.id }) },
                { label: '关闭所有标签页', onClick: () => app.set({ tabs: [], activeTab: LOG_TAB }) },
                t.preview && { label: '固定标签页', onClick: () => pinTab(t.id) },
              ])
            }
          >
            {tabIcon(t)}
            <span className="ellipsis">{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="tab-content">
        <div className="tab-pane" style={{ display: active === LOG_TAB ? 'flex' : 'none' }}>
          <LogView />
        </div>
        {activeTab && (
          <div className="tab-pane" key={activeTab.id}>
            <TabContent tab={activeTab} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status bar

function StatusBar() {
  const info = useApp((s) => s.info)!;
  const tasks = useApp((s) => s.tasks);
  return (
    <div className="statusbar">
      {tasks.length > 0 ? (
        <span className="status-task">
          <LoaderCircle size={12} className="spin" /> {tasks[tasks.length - 1].title}…
          {tasks.length > 1 && <span className="muted"> (+{tasks.length - 1})</span>}
        </span>
      ) : (
        <span className="muted ellipsis">{info.root}</span>
      )}
      <span className="spacer" />
      {info.userName && (
        <span className="muted" title={info.userEmail}>
          {info.userName}
        </span>
      )}
      {info.upstream && (
        <span className="muted">
          {info.head} → {info.upstream}
        </span>
      )}
      <span>
        <GitBranch size={12} /> {info.head ?? info.headHash?.slice(0, 8) ?? '—'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Workspace() {
  const left = useApp((s) => s.leftPanel);

  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      void refreshAll();
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        app.set({ leftPanel: 'commit' });
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('.commit-input')?.focus(), 50);
      } else if (mod && e.key.toLowerCase() === 'k' && e.shiftKey) {
        e.preventDefault();
        void pushDialog();
      } else if (e.key === 'F5') {
        e.preventDefault();
        void refreshAll();
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const leftPanel = useMemo(() => (left === 'stash' ? <StashPanel /> : <CommitPanel />), [left]);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <ToolStrip />
        <Split id="left" dir="h" initial={300} min={220} max={700} minRest={560} hideFirst={!left} first={leftPanel} second={<EditorArea />} />
      </div>
      <StatusBar />
    </div>
  );
}

