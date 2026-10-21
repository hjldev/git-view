import { useEffect, useMemo, useState } from 'react';
import { ChevronsLeft, ChevronsRight, Pencil, Save, SplitSquareHorizontal } from 'lucide-react';
import type { ConflictVersions } from '../../shared/types';
import { api } from '../api';
import { closeTab, runOp, sequenceControl } from '../actions';
import { app } from '../store';
import { confirmDialog } from '../ui/Dialog';
import { toast } from '../ui/Toasts';
import { cx } from '../util';

type Choice = null | 'ours' | 'theirs' | 'both' | 'both-rev' | 'base';

interface Conflict {
  ours: string[];
  base: string[] | null;
  theirs: string[];
}

type Segment = { type: 'text'; lines: string[] } | { type: 'conflict'; c: Conflict; index: number };

/** Splits a file containing conflict markers into plain and conflicting segments. */
export function parseConflicts(text: string): Segment[] {
  const lines = text.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];
  let i = 0;
  let count = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const c: Conflict = { ours: [], base: null, theirs: [] };
      let j = i + 1;
      let part: 'ours' | 'base' | 'theirs' = 'ours';
      let closed = false;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (part === 'ours' && l.startsWith('|||||||')) {
          part = 'base';
          c.base = [];
        } else if ((part === 'ours' || part === 'base') && l.startsWith('=======')) part = 'theirs';
        else if (part === 'theirs' && l.startsWith('>>>>>>>')) {
          closed = true;
          break;
        } else if (part === 'ours') c.ours.push(l);
        else if (part === 'base') c.base!.push(l);
        else c.theirs.push(l);
      }
      if (closed) {
        if (buf.length) segs.push({ type: 'text', lines: buf });
        buf = [];
        segs.push({ type: 'conflict', c, index: count++ });
        i = j + 1;
        continue;
      }
    }
    buf.push(lines[i]);
    i++;
  }
  if (buf.length) segs.push({ type: 'text', lines: buf });
  return segs;
}

function resolved(c: Conflict, choice: Choice, labels: [string, string]): string[] {
  switch (choice) {
    case 'ours':
      return c.ours;
    case 'theirs':
      return c.theirs;
    case 'both':
      return [...c.ours, ...c.theirs];
    case 'both-rev':
      return [...c.theirs, ...c.ours];
    case 'base':
      return c.base ?? [];
    default:
      return [`<<<<<<< ${labels[0]}`, ...c.ours, ...(c.base ? ['|||||||', ...c.base] : []), '=======', ...c.theirs, `>>>>>>> ${labels[1]}`];
  }
}

export function MergeView({ path, tabId }: { path: string; tabId: string }) {
  const [v, setV] = useState<ConflictVersions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [manual, setManual] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .conflict(path)
      .then((r) => {
        if (!alive) return;
        setV(r);
        setChoices([]);
        setManual(null);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path]);

  const segs = useMemo(() => (v?.working ? parseConflicts(v.working) : []), [v]);
  const conflicts = segs.filter((s) => s.type === 'conflict').length;
  const unresolved = segs.filter((s) => s.type === 'conflict' && !choices[s.index]).length;
  const labels: [string, string] = [v?.oursLabel ?? 'ours', v?.theirsLabel ?? 'theirs'];

  const resultText = () =>
    segs.flatMap((s) => (s.type === 'text' ? s.lines : resolved(s.c, choices[s.index] ?? null, labels))).join('\n');

  const setAll = (c: Choice) => setChoices(segs.map((s) => (s.type === 'conflict' ? c : null)));
  const choose = (index: number, c: Choice) => {
    const next = [...choices];
    next[index] = next[index] === c ? null : c;
    setChoices(next);
  };

  const finish = async () => {
    const text = manual ?? resultText();
    if (/^(<<<<<<<|>>>>>>>)/m.test(text)) {
      const ok = await confirmDialog({
        title: '仍有冲突标记',
        message: '结果中仍包含冲突标记（<<<<<<< / >>>>>>>）。仍要保存并标记为已解决吗？',
        okText: '仍然保存',
        danger: true,
      });
      if (!ok) return;
    }
    const r = await runOp('解决冲突', () => api.resolveConflict(path, text), { success: `已解决 ${path}` });
    if (r?.ok) {
      closeTab(tabId);
      setTimeout(() => {
        const st = app.get().status;
        if (st && st.conflicted.length === 0 && st.state !== 'clean') {
          toast({
            type: 'info',
            title: '所有冲突已解决',
            actions: [{ label: '继续', onClick: () => void sequenceControl('continue') }],
          });
        }
      }, 600);
    }
  };

  const acceptSide = async (side: 'ours' | 'theirs') => {
    const r = await runOp(side === 'ours' ? '接受您的版本' : '接受他们的版本', () => api.acceptConflict([path], side));
    if (r?.ok) closeTab(tabId);
  };

  if (error) return <div className="diff-msg c-error">{error}</div>;
  if (!v) return <div className="diff-msg muted">正在加载冲突…</div>;

  const toolbar = (
    <div className="diff-toolbar merge-toolbar">
      <span className="mono small ellipsis">{path}</span>
      {conflicts > 0 && (
        <span className={cx('badge small', unresolved ? 'st-conflict' : 'st-added')}>
          {unresolved ? `${unresolved}/${conflicts} 处冲突未解决` : '全部已选择'}
        </span>
      )}
      <span className="spacer" />
      <button className="btn small" onClick={() => (conflicts && manual === null ? setAll('ours') : acceptSide('ours'))}>
        <ChevronsRight size={13} /> 全部采用您的
      </button>
      <button className="btn small" onClick={() => (conflicts && manual === null ? setAll('theirs') : acceptSide('theirs'))}>
        全部采用他们的 <ChevronsLeft size={13} />
      </button>
      {v.working !== null && (
        <button className={cx('btn small', manual !== null && 'active')} onClick={() => setManual(manual === null ? resultText() : null)}>
          {manual === null ? <Pencil size={13} /> : <SplitSquareHorizontal size={13} />}
          {manual === null ? '手动编辑' : '返回冲突视图'}
        </button>
      )}
      {v.working !== null && (
        <button className="btn small primary" onClick={finish}>
          <Save size={13} /> 应用并标记为已解决
        </button>
      )}
    </div>
  );

  if (v.working === null || (conflicts === 0 && manual === null)) {
    return (
      <div className="merge-view">
        {toolbar}
        <div className="merge-simple">
          {v.working === null ? (
            <p>工作区中不存在此文件（一方删除了它）。请选择保留哪一方的版本：</p>
          ) : (
            <p>文件中没有找到冲突标记。可以手动编辑，或直接采用某一方的版本。</p>
          )}
          <div className="merge-sides">
            <div>
              <div className="merge-col-title">您的版本 · {v.oursLabel}</div>
              <pre className="merge-pre">{v.ours ?? '（已删除）'}</pre>
            </div>
            <div>
              <div className="merge-col-title">他们的版本 · {v.theirsLabel}</div>
              <pre className="merge-pre">{v.theirs ?? '（已删除）'}</pre>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (manual !== null) {
    return (
      <div className="merge-view">
        {toolbar}
        <textarea className="merge-editor mono" value={manual} spellCheck={false} onChange={(e) => setManual(e.target.value)} />
      </div>
    );
  }

  return (
    <div className="merge-view">
      {toolbar}
      <div className="merge-head">
        <div>您的版本 · {v.oursLabel}</div>
        <div>结果</div>
        <div>他们的版本 · {v.theirsLabel}</div>
      </div>
      <div className="merge-body">
        {segs.map((s, i) => {
          if (s.type === 'text') {
            const lines = s.lines;
            const long = lines.length > 10;
            return (
              <pre key={i} className="merge-text">
                {long ? [...lines.slice(0, 4), `⋯ ${lines.length - 8} 行未冲突内容 ⋯`, ...lines.slice(-4)].join('\n') : lines.join('\n')}
              </pre>
            );
          }
          const choice = choices[s.index] ?? null;
          return (
            <div key={i} className={cx('merge-conflict', choice && 'resolved')}>
              <pre className={cx('merge-side ours', (choice === 'ours' || choice?.startsWith('both')) && 'picked')}>{s.c.ours.join('\n') || ' '}</pre>
              <div className="merge-result">
                <div className="merge-choices">
                  <button className={cx('mini-btn wide', choice === 'ours' && 'active')} onClick={() => choose(s.index, 'ours')}>
                    « 您的
                  </button>
                  <button className={cx('mini-btn wide', choice === 'both' && 'active')} onClick={() => choose(s.index, 'both')} title="先您的，后他们的">
                    两者
                  </button>
                  <button className={cx('mini-btn wide', choice === 'both-rev' && 'active')} onClick={() => choose(s.index, 'both-rev')} title="先他们的，后您的">
                    两者(反)
                  </button>
                  <button className={cx('mini-btn wide', choice === 'theirs' && 'active')} onClick={() => choose(s.index, 'theirs')}>
                    他们的 »
                  </button>
                </div>
                <pre className={cx('merge-res', !choice && 'unresolved')}>
                  {choice ? resolved(s.c, choice, labels).join('\n') || '（空）' : `冲突 #${s.index + 1}：请选择`}
                </pre>
              </div>
              <pre className={cx('merge-side theirs', (choice === 'theirs' || choice?.startsWith('both')) && 'picked')}>{s.c.theirs.join('\n') || ' '}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
