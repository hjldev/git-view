import { useState } from 'react';
import { FileWarning } from 'lucide-react';
import { api } from '../api';
import { openTab, runOp, sequenceControl } from '../actions';
import { useApp } from '../store';
import { Modal, openDialog } from '../ui/Dialog';
import { basename, cx, dirname } from '../util';

const OURS: Record<string, string> = { UU: '已修改', AA: '已添加', DU: '已删除', UD: '已修改', AU: '已添加', UA: '—', DD: '已删除' };
const THEIRS: Record<string, string> = { UU: '已修改', AA: '已添加', DU: '已修改', UD: '已删除', AU: '—', UA: '已添加', DD: '已删除' };

const STATE_TEXT: Record<string, string> = {
  merging: '合并',
  rebasing: '变基',
  'cherry-picking': '优选',
  reverting: '还原',
};

export function ConflictsDialog() {
  return openDialog<void>((done) => <ConflictsForm done={done} />);
}

function ConflictsForm({ done }: { done: () => void }) {
  const conflicts = useApp((s) => s.status?.conflicted ?? []);
  const state = useApp((s) => s.status?.state ?? 'clean');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sel = conflicts.filter((c) => selected.has(c.path)).map((c) => c.path);
  const targets = sel.length ? sel : conflicts.map((c) => c.path);

  const accept = async (side: 'ours' | 'theirs', paths = targets) => {
    await runOp(side === 'ours' ? '接受您的版本' : '接受他们的版本', () => api.acceptConflict(paths, side));
    setSelected(new Set());
  };

  const merge = (path: string) => {
    done();
    openTab({ type: 'merge', path });
  };

  const op = STATE_TEXT[state] ?? '合并';
  return (
    <Modal
      title="冲突"
      onClose={done}
      width={720}
      footer={
        <>
          {conflicts.length === 0 && state !== 'clean' && (
            <>
              <span className="c-success">所有冲突已解决。</span>
              <button
                className="btn primary"
                onClick={() => {
                  done();
                  void sequenceControl('continue');
                }}
              >
                继续{op}
              </button>
            </>
          )}
          <span className="spacer" />
          {state !== 'clean' && (
            <button
              className="btn"
              onClick={() => {
                done();
                void sequenceControl('abort');
              }}
            >
              中止{op}
            </button>
          )}
          <button className="btn" onClick={done}>
            关闭
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginBottom: 8 }}>
        {state !== 'clean' ? `正在进行${op}，以下文件存在冲突：` : '以下文件存在冲突：'}
      </div>
      <div className="conflicts">
        <div className="conflicts-table">
          <div className="conflict-row head">
            <span>名称</span>
            <span>您的版本</span>
            <span>他们的版本</span>
          </div>
          {conflicts.length === 0 && <div className="muted pad">没有冲突</div>}
          {conflicts.map((c) => (
            <div
              key={c.path}
              className={cx('conflict-row', selected.has(c.path) && 'selected')}
              onClick={(e) => {
                const next = new Set(e.metaKey || e.ctrlKey ? selected : []);
                if (next.has(c.path)) next.delete(c.path);
                else next.add(c.path);
                setSelected(next);
              }}
              onDoubleClick={() => merge(c.path)}
            >
              <span className="ellipsis">
                <FileWarning size={14} className="c-error" /> {basename(c.path)}{' '}
                <span className="muted small">{dirname(c.path)}</span>
              </span>
              <span>{OURS[c.conflict ?? 'UU']}</span>
              <span>{THEIRS[c.conflict ?? 'UU']}</span>
            </div>
          ))}
        </div>
        <div className="conflicts-actions">
          <button className="btn" disabled={!conflicts.length} onClick={() => accept('ours')}>
            接受您的
          </button>
          <button className="btn" disabled={!conflicts.length} onClick={() => accept('theirs')}>
            接受他们的
          </button>
          <button className="btn primary" disabled={sel.length !== 1 && conflicts.length !== 1} onClick={() => merge(sel[0] ?? conflicts[0].path)}>
            合并…
          </button>
        </div>
      </div>
    </Modal>
  );
}
