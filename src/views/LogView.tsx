import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, Eye, FileSearch, GitBranch, PanelBottom, PanelRight, RefreshCw, Search, SlidersHorizontal, User, X } from 'lucide-react';
import type { Author, Commit, DiffSpec } from '../../shared/types';
import { api } from '../api';
import { openDiff, refreshAll } from '../actions';
import { commitMenu } from '../menus';
import { app, emptyFilter, useApp, usePref, type LogFilter } from '../store';
import { showMenu, showMenuAt, type MenuEntry } from '../ui/ContextMenu';
import { promptDialog } from '../ui/Dialog';
import { Split } from '../ui/Split';
import { toast } from '../ui/Toasts';
import { cx, debounce } from '../util';
import { BranchTree } from './BranchTree';
import { CommitDetails } from './CommitDetails';
import { CommitTable } from './CommitTable';
import { DiffView } from './DiffView';
import { layoutGraph } from './graph';

const PAGE = 2000;
/** Edges spanning more rows than this are drawn as arrows (IDEA hides long edges). */
const LONG_EDGE = 40;

function FilterButton(props: { icon: React.ReactNode; label: string; value: string; onClick: (el: HTMLElement) => void; onClear: () => void }) {
  return (
    <button className={cx('filter-btn', props.value && 'active')} onClick={(e) => props.onClick(e.currentTarget)}>
      {props.icon}
      <span className="nowrap">
        {props.label}
        {props.value ? `: ${props.value}` : ''}
      </span>
      {props.value ? (
        <X
          size={12}
          className="filter-clear"
          onClick={(e) => {
            e.stopPropagation();
            props.onClear();
          }}
        />
      ) : (
        <ChevronDown size={12} />
      )}
    </button>
  );
}

function FilterBar() {
  const filter = useApp((s) => s.logFilter);
  const refs = useApp((s) => s.refs);
  const info = useApp((s) => s.info);
  const [text, setText] = useState(filter.text);
  const [authors, setAuthors] = useState<Author[] | null>(null);
  const setFilter = (p: Partial<LogFilter>) => app.set((s) => ({ logFilter: { ...s.logFilter, ...p } }));
  const debounced = useMemo(() => debounce((v: string) => setFilter({ text: v.trim() }), 350), []);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setText(filter.text), [filter.text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && app.get().activeTab === 'log') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const branchMenu = (el: HTMLElement) => {
    const items: MenuEntry[] = [
      { label: '全部', checked: filter.branches.length === 0, onClick: () => setFilter({ branches: [] }) },
      { label: 'HEAD', checked: filter.branches[0] === 'HEAD', onClick: () => setFilter({ branches: ['HEAD'] }) },
      'sep',
      { header: '本地分支' },
      ...(refs?.local ?? []).map((b) => ({
        label: b.name,
        checked: filter.branches[0] === b.name,
        onClick: () => setFilter({ branches: [b.name] }),
      })),
      (refs?.remote.length ?? 0) > 0 && 'sep',
      (refs?.remote.length ?? 0) > 0 && {
        label: '远程分支',
        submenu: (refs?.remote ?? []).map((b) => ({
          label: b.name,
          checked: filter.branches[0] === b.name,
          onClick: () => setFilter({ branches: [b.name] }),
        })),
      },
    ];
    showMenuAt(el, items);
  };

  const userMenu = async (el: HTMLElement) => {
    let list = authors;
    if (!list) {
      list = await api.authors().catch(() => []);
      setAuthors(list);
    }
    showMenuAt(el, [
      { label: '全部', checked: !filter.author, onClick: () => setFilter({ author: '' }) },
      info?.userName && { label: `我（${info.userName}）`, onClick: () => setFilter({ author: info.userName }) },
      'sep',
      ...list.slice(0, 40).map((a) => ({
        label: a.name,
        hint: String(a.count),
        checked: filter.author === a.name,
        onClick: () => setFilter({ author: a.name }),
      })),
    ]);
  };

  const dates: [string, string][] = [
    ['24 hours ago', '最近 24 小时'],
    ['1 week ago', '最近 7 天'],
    ['1 month ago', '最近 30 天'],
    ['1 year ago', '最近一年'],
  ];
  const dateLabel = dates.find(([v]) => v === filter.since)?.[1] ?? filter.since;

  const hasFilter = filter.text || filter.branches.length || filter.author || filter.since || filter.path;

  return (
    <div className="log-filters">
      <div className="search-box grow">
        <Search size={13} className="muted" />
        <input
          ref={inputRef}
          placeholder="文本或哈希 (⌘F)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            debounced(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setFilter({ text: text.trim() });
            if (e.key === 'Escape') {
              setText('');
              setFilter({ text: '' });
            }
          }}
        />
        {text && (
          <button
            className="icon-btn"
            onClick={() => {
              setText('');
              setFilter({ text: '' });
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <FilterButton icon={<GitBranch size={13} />} label="分支" value={filter.branches.join(', ')} onClick={branchMenu} onClear={() => setFilter({ branches: [] })} />
      <FilterButton icon={<User size={13} />} label="用户" value={filter.author} onClick={userMenu} onClear={() => setFilter({ author: '' })} />
      <FilterButton
        icon={<Calendar size={13} />}
        label="日期"
        value={filter.since ? dateLabel : ''}
        onClick={(el) =>
          showMenuAt(el, [
            { label: '全部', checked: !filter.since, onClick: () => setFilter({ since: '' }) },
            'sep',
            ...dates.map(([v, l]) => ({ label: l, checked: filter.since === v, onClick: () => setFilter({ since: v }) })),
          ])
        }
        onClear={() => setFilter({ since: '' })}
      />
      <FilterButton
        icon={<FileSearch size={13} />}
        label="路径"
        value={filter.path}
        onClick={async () => {
          const p = await promptDialog({ title: '按路径筛选', label: '相对于仓库根目录的文件或目录路径', initial: filter.path, placeholder: '例如 src/app.js' });
          if (p !== null) setFilter({ path: p.trim() });
        }}
        onClear={() => setFilter({ path: '' })}
      />
      {hasFilter && (
        <button className="link-btn small nowrap" onClick={() => app.set({ logFilter: emptyFilter })}>
          清除筛选
        </button>
      )}
    </div>
  );
}

interface LogData {
  commits: Commit[];
  hasMore: boolean;
  flat: boolean;
}

export function LogView() {
  const repoPath = useApp((s) => s.repoPath);
  const logVersion = useApp((s) => s.logVersion);
  const filter = useApp((s) => s.logFilter);
  const info = useApp((s) => s.info);
  const reveal = useApp((s) => s.reveal);
  const [showDetails, setShowDetails] = usePref('log.details', true);
  const [showBranches, setShowBranches] = usePref('log.branches', true);
  const [showPreview, setShowPreview] = usePref('log.diffPreview', true);
  const [order, setOrder] = usePref<'date' | 'topo'>('log.order', 'date');
  const [longEdges, setLongEdges] = usePref('log.longEdges', false);
  const [data, setData] = useState<LogData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ spec: DiffSpec; specs: DiffSpec[]; index: number } | null>(null);
  const [scrollTo, setScrollTo] = useState<{ index: number; seq: number } | null>(null);
  const req = useRef(0);
  const loadedCount = useRef(0);
  const initialSelect = useRef(true);
  const pendingReveal = useRef<string | null>(null);

  const query = useMemo(
    () => ({
      grep: filter.text || undefined,
      branches: filter.branches.length ? filter.branches : undefined,
      author: filter.author || undefined,
      since: filter.since || undefined,
      path: filter.path || undefined,
      order,
    }),
    [filter, order],
  );

  // Reset the selection when switching repositories or filters.
  useEffect(() => {
    initialSelect.current = true;
    loadedCount.current = 0;
  }, [repoPath, query]);

  useEffect(() => {
    if (!repoPath) return;
    const id = ++req.current;
    setLoading(true);
    setError(null);
    api
      .log({ ...query, max: Math.max(PAGE, loadedCount.current) })
      .then((r) => {
        if (id !== req.current) return;
        setData(r);
        loadedCount.current = r.commits.length;
        if (initialSelect.current) {
          initialSelect.current = false;
          const head = app.get().info?.headHash;
          const idx = r.commits.findIndex((c) => c.hash === head);
          const target = idx >= 0 ? idx : 0;
          if (r.commits[target]) {
            setSelected(new Set([r.commits[target].hash]));
            setPrimary(r.commits[target].hash);
            setScrollTo({ index: target, seq: Date.now() });
          } else {
            setSelected(new Set());
            setPrimary(null);
          }
        }
        if (pendingReveal.current) {
          const h = pendingReveal.current;
          pendingReveal.current = null;
          doReveal(h, r.commits);
        }
      })
      .catch((e) => id === req.current && setError(e.message))
      .finally(() => id === req.current && setLoading(false));
  }, [repoPath, logVersion, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!data?.hasMore || loading) return;
    const id = ++req.current;
    setLoading(true);
    api
      .log({ ...query, max: PAGE, skip: data.commits.length })
      .then((r) => {
        if (id !== req.current) return;
        setData((d) => (d ? { commits: [...d.commits, ...r.commits], hasMore: r.hasMore, flat: d.flat } : r));
        loadedCount.current += r.commits.length;
      })
      .finally(() => id === req.current && setLoading(false));
  }, [data, loading, query]);

  const doReveal = (hash: string, commits: Commit[]) => {
    const idx = commits.findIndex((c) => c.hash === hash || c.hash.startsWith(hash));
    if (idx < 0) {
      toast({ type: 'warn', title: '提交不在当前日志中', message: '可能被筛选条件排除，或位于尚未加载的历史中。' });
      return;
    }
    setSelected(new Set([commits[idx].hash]));
    setPrimary(commits[idx].hash);
    setScrollTo({ index: idx, seq: Date.now() });
  };

  useEffect(() => {
    if (!reveal) return;
    if (data && !loading) doReveal(reveal.hash, data.commits);
    else pendingReveal.current = reveal.hash;
  }, [reveal?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop the diff preview when the commit changes.
  useEffect(() => setPreview(null), [primary]);

  const commits = data?.commits ?? [];
  const graph = useMemo(
    () => layoutGraph(commits, data?.flat ?? false, longEdges ? Infinity : LONG_EDGE),
    [commits, data?.flat, longEdges],
  );
  const selectedCommits = commits.filter((c) => selected.has(c.hash));

  const table = (
    <div className="panel log-center">
      <FilterBar />
      <div className="log-table-wrap">
        {error && <div className="diff-msg c-error">{error}</div>}
        {!error && data && commits.length === 0 && (
          <div className="empty-hint">{query.grep || query.author || query.path || query.since ? '没有匹配的提交' : '仓库中还没有提交'}</div>
        )}
        {commits.length > 0 && (
          <CommitTable
            commits={commits}
            graph={graph}
            headHash={info?.headHash ?? null}
            headBranch={info?.head ?? null}
            selected={selected}
            primary={primary}
            scrollToIndex={scrollTo}
            onSelect={(s, p) => {
              setSelected(s);
              setPrimary(p);
            }}
            onContextMenu={(e, c) => {
              const sel = selected.has(c.hash) ? selectedCommits : [c];
              showMenu(e, commitMenu(sel.length ? sel : [c]));
            }}
            onActivate={async (c) => {
              const d = await api.commit(c.hash);
              const specs = d.files.map((f) => ({ kind: 'commit' as const, hash: d.hash, path: f.path, oldPath: f.oldPath }));
              openDiff(specs, 0, false);
            }}
            onNearEnd={loadMore}
          />
        )}
        {loading && <div className="loading-bar" />}
      </div>
    </div>
  );

  const center =
    showPreview && preview ? (
      <Split
        id="log.preview"
        dir="v"
        fixed="second"
        initial={360}
        min={120}
        first={table}
        second={
          <div className="panel">
            <div className="panel-toolbar">
              <span className="ellipsis small mono">{'path' in preview.spec ? preview.spec.path : ''}</span>
              <span className="spacer" />
              <button className="link-btn small" onClick={() => openDiff(preview.specs, preview.index, false)}>
                在标签页中打开
              </button>
              <button className="icon-btn" title="关闭预览" onClick={() => setPreview(null)}>
                <X size={14} />
              </button>
            </div>
            <DiffView
              spec={preview.spec}
              compact
              nav={{
                index: preview.index,
                total: preview.specs.length,
                prev: () => setPreview({ ...preview, index: preview.index - 1, spec: preview.specs[preview.index - 1] }),
                next: () => setPreview({ ...preview, index: preview.index + 1, spec: preview.specs[preview.index + 1] }),
              }}
            />
          </div>
        }
      />
    ) : (
      table
    );

  const main = (
    <Split
      id="log.details"
      dir="h"
      fixed="second"
      initial={320}
      min={200}
      minRest={320}
      hideSecond={!showDetails}
      first={center}
      second={
        <CommitDetails
          hash={primary}
          count={selected.size}
          previewPath={preview && 'path' in preview.spec ? preview.spec.path ?? null : null}
          onPreview={(spec, specs, index) => {
            if (!spec) return setPreview(null);
            if (showPreview) setPreview({ spec, specs, index });
            else openDiff(specs, index, true);
          }}
        />
      }
    />
  );

  return (
    <div className="log-view">
      <div className="log-side-toolbar">
        <button className={cx('icon-btn', showBranches && 'active')} title="显示分支面板" onClick={() => setShowBranches(!showBranches)}>
          <GitBranch size={15} />
        </button>
        <button className="icon-btn" title="刷新 (⌘R)" onClick={() => refreshAll()}>
          <RefreshCw size={15} className={cx(loading && 'spin')} />
        </button>
        <span className="tb-sep-h" />
        <button className={cx('icon-btn', showDetails && 'active')} title="显示提交详情" onClick={() => setShowDetails(!showDetails)}>
          <PanelRight size={15} />
        </button>
        <button className={cx('icon-btn', showPreview && 'active')} title="显示差异预览" onClick={() => setShowPreview(!showPreview)}>
          <PanelBottom size={15} />
        </button>
        <button
          className="icon-btn"
          title="显示选项"
          onClick={(e) =>
            showMenuAt(e.currentTarget, [
              { header: '排序' },
              { label: '按提交日期', checked: order === 'date', onClick: () => setOrder('date') },
              { label: '拓扑顺序（分支集中显示）', checked: order === 'topo', onClick: () => setOrder('topo') },
              'sep',
              { label: '显示长连线', checked: longEdges, onClick: () => setLongEdges(!longEdges) },
            ])
          }
        >
          <SlidersHorizontal size={15} />
        </button>
        <span className="tb-sep-h" />
        <button
          className="icon-btn"
          title="定位到 HEAD"
          onClick={() => {
            const h = app.get().info?.headHash;
            if (h && data) doReveal(h, data.commits);
          }}
        >
          <Eye size={15} />
        </button>
      </div>
      <Split id="log.branches" dir="h" initial={190} min={130} max={500} minRest={540} hideFirst={!showBranches} first={<BranchTree />} second={main} />
    </div>
  );
}
