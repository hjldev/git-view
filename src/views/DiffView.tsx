import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Columns2,
  FoldVertical,
  Minus,
  Plus,
  Rows3,
  Undo2,
  UnfoldVertical,
  WrapText,
} from 'lucide-react';
import type { DiffSpec, FileDiff } from '../../shared/types';
import { api } from '../api';
import { runOp } from '../actions';
import { useApp, usePref } from '../store';
import { confirmDialog } from '../ui/Dialog';
import { cx, statusClass, STATUS_LABEL } from '../util';
import { blockPatch, buildRows, type ChangeBlock, type Row, type Side } from './diffModel';
import { highlightLines, markRanges, type Seg } from './highlight';

interface Highlighted {
  old: Map<number, Seg[]>;
  new: Map<number, Seg[]>;
}

function highlightFile(file: FileDiff): Highlighted | null {
  const path = file.newPath ?? file.oldPath ?? '';
  const oldL: { no: number; s: string }[] = [];
  const newL: { no: number; s: string }[] = [];
  for (const h of file.hunks)
    for (const l of h.lines) {
      if (l.o !== undefined) oldL.push({ no: l.o, s: l.s });
      if (l.n !== undefined) newL.push({ no: l.n, s: l.s });
    }
  const ho = highlightLines(oldL.map((l) => l.s).join('\n'), path);
  const hn = highlightLines(newL.map((l) => l.s).join('\n'), path);
  if (!ho && !hn) return null;
  const old = new Map<number, Seg[]>();
  const nw = new Map<number, Seg[]>();
  oldL.forEach((l, i) => ho?.[i] && old.set(l.no, ho[i]));
  newL.forEach((l, i) => hn?.[i] && nw.set(l.no, hn[i]));
  return { old, new: nw };
}

const Code = memo(function Code({ side, segs }: { side: Side; segs?: Seg[] }) {
  const base = segs ?? [{ text: side.text, cls: '' }];
  const parts = markRanges(base, side.words, side.type === 'add' ? 'w-add' : 'w-del');
  if (!side.text) return <span className="code-empty">{'​'}</span>;
  return (
    <>
      {parts.map((p, i) =>
        p.cls ? (
          <span key={i} className={p.cls}>
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
});

export interface DiffNav {
  index: number;
  total: number;
  prev: () => void;
  next: () => void;
}

const LIVE_KINDS = new Set(['unstaged', 'staged', 'untracked']);

export function DiffView({ spec, nav, compact }: { spec: DiffSpec; nav?: DiffNav; compact?: boolean }) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefMode, setMode] = usePref<'split' | 'unified'>('diff.mode', 'split');
  const [narrow, setNarrow] = useState(false);
  const [ignoreWs, setIgnoreWs] = usePref('diff.ignoreWs', false);
  const [collapse, setCollapse] = usePref('diff.collapse', true);
  const [wrap, setWrap] = usePref('diff.wrap', true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const specKey = JSON.stringify(spec);
  // Side-by-side needs room; fall back to the unified layout in narrow panes.
  const mode = narrow ? 'unified' : prefMode;
  useLayoutEffect(() => {
    const el = bodyRef.current!;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const live = LIVE_KINDS.has(spec.kind);
  // Re-fetch working tree diffs whenever the status changes.
  const statusVersion = useApp((s) => (live ? s.status : null));

  useEffect(() => {
    setExpanded(new Set());
    setFiles(null);
  }, [specKey]);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .diff(spec, ignoreWs)
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [specKey, ignoreWs, statusVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = spec.kind === 'unstaged' ? 'unstaged' : spec.kind === 'staged' ? 'staged' : null;

  const runBlock = async (file: FileDiff, block: ChangeBlock, action: 'stage' | 'unstage' | 'revert') => {
    const patch = blockPatch(file, block);
    if (action === 'revert') {
      const ok = await confirmDialog({ title: '回滚更改', message: '确定要回滚此处的更改吗？此操作无法撤销。', okText: '回滚', danger: true });
      if (!ok) return;
    }
    const title = action === 'stage' ? '暂存代码块' : action === 'unstage' ? '取消暂存代码块' : '回滚代码块';
    await runOp(title, () =>
      api.applyPatch(patch, { cached: action !== 'revert', reverse: action !== 'stage' }),
    );
  };

  const jump = (dir: 1 | -1) => {
    const body = bodyRef.current;
    if (!body) return;
    const marks = [...body.querySelectorAll<HTMLElement>('[data-block-start]')];
    if (!marks.length) return;
    const top = body.scrollTop + 4;
    const bodyTop = body.getBoundingClientRect().top;
    const pos = marks.map((m) => m.getBoundingClientRect().top - bodyTop + body.scrollTop);
    let target: number | undefined;
    if (dir === 1) target = pos.find((p) => p > top + 30);
    else target = [...pos].reverse().find((p) => p < top - 4);
    if (target === undefined) target = dir === 1 ? pos[0] : pos[pos.length - 1];
    body.scrollTo({ top: Math.max(0, target - 60), behavior: 'smooth' });
  };

  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    files?.forEach((f) => f.hunks.forEach((h) => h.lines.forEach((l) => (l.t === 'add' ? add++ : l.t === 'del' ? del++ : 0))));
    return { add, del };
  }, [files]);

  return (
    <div className={cx('diff-view', compact && 'compact', wrap && 'wrap')}>
      <div className="diff-toolbar">
        {nav && (
          <>
            <button className="icon-btn" title="上一个文件" disabled={nav.index <= 0} onClick={nav.prev}>
              <ChevronLeft size={15} />
            </button>
            <span className="muted small nowrap">
              {nav.index + 1}/{nav.total}
            </span>
            <button className="icon-btn" title="下一个文件" disabled={nav.index >= nav.total - 1} onClick={nav.next}>
              <ChevronRight size={15} />
            </button>
            <span className="tb-sep" />
          </>
        )}
        <button className="icon-btn" title="上一处差异 (Shift+F7)" onClick={() => jump(-1)}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn" title="下一处差异 (F7)" onClick={() => jump(1)}>
          <ArrowDown size={15} />
        </button>
        <span className="tb-sep" />
        <button
          className={cx('icon-btn', mode === 'split' && 'active')}
          title={narrow ? '区域太窄，无法并排查看' : '并排查看'}
          disabled={narrow}
          onClick={() => setMode('split')}
        >
          <Columns2 size={15} />
        </button>
        <button className={cx('icon-btn', mode === 'unified' && 'active')} title="统一查看" onClick={() => setMode('unified')}>
          <Rows3 size={15} />
        </button>
        <button
          className={cx('icon-btn', collapse && 'active')}
          title={collapse ? '展开未更改的片段' : '折叠未更改的片段'}
          onClick={() => {
            setCollapse(!collapse);
            setExpanded(new Set());
          }}
        >
          {collapse ? <FoldVertical size={15} /> : <UnfoldVertical size={15} />}
        </button>
        <button className={cx('icon-btn', wrap && 'active')} title="自动换行" onClick={() => setWrap(!wrap)}>
          <WrapText size={15} />
        </button>
        <label className="check small" title="忽略空白字符变化">
          <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
          忽略空白
        </label>
        <span className="spacer" />
        {files && (
          <span className="stats small nowrap">
            <span className="c-add">+{stats.add}</span> <span className="c-del">−{stats.del}</span>
          </span>
        )}
      </div>
      <div
        className="diff-body"
        ref={bodyRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'F7') {
            e.preventDefault();
            jump(e.shiftKey ? -1 : 1);
          }
        }}
      >
        {error && <div className="diff-msg c-error">{error}</div>}
        {!files && !error && <div className="diff-msg muted loading">正在加载…</div>}
        {files && files.length === 0 && <div className="diff-msg muted">没有差异</div>}
        {files?.map((f, i) => (
          <FileDiffBody
            key={`${f.oldPath}:${f.newPath}:${i}`}
            file={f}
            mode={mode}
            collapse={collapse}
            expanded={expanded}
            showHeader={files.length > 1 || !compact}
            onExpand={(k) => setExpanded(new Set(expanded).add(k))}
            actions={actions}
            onBlock={runBlock}
          />
        ))}
      </div>
    </div>
  );
}

function FileDiffBody(props: {
  file: FileDiff;
  mode: 'split' | 'unified';
  collapse: boolean;
  expanded: Set<string>;
  showHeader: boolean;
  onExpand: (key: string) => void;
  actions: 'unstaged' | 'staged' | null;
  onBlock: (file: FileDiff, block: ChangeBlock, action: 'stage' | 'unstage' | 'revert') => void;
}) {
  const { file, mode } = props;
  const hl = useMemo(() => highlightFile(file), [file]);
  const { rows, blocks } = useMemo(
    () => buildRows(file, mode, props.collapse, props.expanded),
    [file, mode, props.collapse, props.expanded],
  );
  const path = file.newPath ?? file.oldPath ?? '';
  const header = props.showHeader && (
    <div className="diff-file-header">
      <span className={cx('badge', statusClass(file.status))}>{STATUS_LABEL[file.status]}</span>
      <span className="mono ellipsis">{file.oldPath && file.newPath && file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : path}</span>
      {file.oldMode && file.newMode && file.oldMode !== file.newMode && (
        <span className="muted small">
          模式 {file.oldMode} → {file.newMode}
        </span>
      )}
    </div>
  );
  if (file.binary) {
    return (
      <div className="diff-file">
        {header}
        <div className="diff-msg muted">二进制文件，无法显示文本差异</div>
      </div>
    );
  }
  if (!file.hunks.length) {
    return (
      <div className="diff-file">
        {header}
        <div className="diff-msg muted">{file.status === 'R' ? '文件已重命名，内容未改变' : '文件内容相同'}</div>
      </div>
    );
  }

  const segsFor = (side: Side | undefined, which: 'old' | 'new') => (side && hl ? hl[which].get(side.no) : undefined);

  const actionButtons = (block: number) => {
    if (!props.actions) return null;
    const b = blocks[block];
    return (
      <span className="block-actions">
        {props.actions === 'unstaged' ? (
          <>
            <button className="mini-btn" title="暂存此代码块" onClick={() => props.onBlock(file, b, 'stage')}>
              <Plus size={12} />
            </button>
            <button className="mini-btn" title="回滚此代码块" onClick={() => props.onBlock(file, b, 'revert')}>
              <Undo2 size={12} />
            </button>
          </>
        ) : (
          <button className="mini-btn" title="取消暂存此代码块" onClick={() => props.onBlock(file, b, 'unstage')}>
            <Minus size={12} />
          </button>
        )}
      </span>
    );
  };

  const renderRow = (r: Row, i: number) => {
    switch (r.kind) {
      case 'fold':
        return (
          <div key={`f${r.key}`} className="diff-fold" onClick={() => props.onExpand(r.key)}>
            <UnfoldVertical size={13} /> 展开 {r.count} 行未更改的内容
          </div>
        );
      case 'gap':
        return (
          <div key={`g${i}`} className="diff-gap">
            ⋯ {r.header}
          </div>
        );
      case 'meta':
        return (
          <div key={`m${i}`} className="diff-meta">
            {r.text === 'No newline at end of file' ? '文件末尾没有换行符' : r.text}
          </div>
        );
      case 'split':
        return (
          <div
            key={i}
            className={cx('dl-split', r.bk && `b-${r.bk}`)}
            data-block-start={r.blockStart ? '' : undefined}
          >
            <span className={cx('ln', r.left && `t-${r.left.type}`, !r.left && 'filler')}>{r.left?.no}</span>
            <span className={cx('code', r.left ? `t-${r.left.type}` : 'filler')}>
              {r.left && <Code side={r.left} segs={segsFor(r.left, 'old')} />}
            </span>
            <span className="gutter">{r.blockStart && r.block !== undefined && actionButtons(r.block)}</span>
            <span className={cx('ln', r.right && `t-${r.right.type}`, !r.right && 'filler')}>{r.right?.no}</span>
            <span className={cx('code', r.right ? `t-${r.right.type}` : 'filler')}>
              {r.right && <Code side={r.right} segs={segsFor(r.right, 'new')} />}
            </span>
          </div>
        );
      case 'unified':
        return (
          <div key={i} className={cx('dl-unified', `t-${r.side.type}`)} data-block-start={r.blockStart ? '' : undefined}>
            <span className="gutter">{r.blockStart && r.block !== undefined && actionButtons(r.block)}</span>
            <span className="ln">{r.old}</span>
            <span className="ln">{r.new}</span>
            <span className="sign">{r.side.type === 'add' ? '+' : r.side.type === 'del' ? '−' : ' '}</span>
            <span className="code">
              <Code side={r.side} segs={segsFor(r.side, r.side.type === 'del' ? 'old' : 'new')} />
            </span>
          </div>
        );
    }
  };

  return (
    <div className="diff-file">
      {header}
      {file.truncated && <div className="diff-msg c-warn">差异过大，仅显示部分内容</div>}
      <div className={cx('diff-grid', mode === 'split' ? 'mode-split' : 'mode-unified', props.actions && 'has-actions')}>
        {rows.map(renderRow)}
      </div>
    </div>
  );
}
