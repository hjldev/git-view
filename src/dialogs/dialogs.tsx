import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitCommitHorizontal, Trash2, Pencil, Plus } from 'lucide-react';
import type { Commit } from '../../shared/types';
import { api } from '../api';
import { checkoutRevision, refreshInfo, runOp } from '../actions';
import { app, getPref, setPref } from '../store';
import { confirmDialog, Modal, openDialog, promptDialog } from '../ui/Dialog';
import { cx, formatDate, shortHash } from '../util';

export function validateBranchName(name: string): string | null {
  if (!name.trim()) return '名称不能为空';
  if (/\s/.test(name)) return '名称不能包含空白字符';
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(name)) return '名称包含非法字符';
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return '名称格式无效';
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock'))
    return '名称格式无效';
  return null;
}

// ---------------------------------------------------------------------------

function NewBranchForm(props: { start?: string; startLabel?: string; done: (v: void) => void }) {
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(getPref('newBranch.checkout', true));
  const [force, setForce] = useState(false);
  const exists = app.get().refs?.local.some((b) => b.name === name);
  const err = validateBranchName(name) ?? (exists && !force ? `分支 “${name}” 已存在` : null);
  const submit = async () => {
    if (err) return;
    setPref('newBranch.checkout', checkout);
    props.done();
    await runOp(`创建分支 ${name}`, () => api.createBranch(name, props.start, checkout, force), {
      success: checkout ? `已创建并检出分支 ${name}` : `已创建分支 ${name}`,
    });
  };
  return (
    <Modal
      title={`新建分支${props.startLabel ? `（自 ${props.startLabel}）` : ''}`}
      onClose={() => props.done()}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => props.done()}>
            取消
          </button>
          <button className="btn primary" disabled={!!err} onClick={submit}>
            创建
          </button>
        </>
      }
    >
      <div className="form">
        <label className="form-label">新分支名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 feature/my-change" />
        {name && err && <div className="form-error">{err}</div>}
        <label className="check">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} /> 检出分支
        </label>
        {exists && (
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 覆盖已有分支
          </label>
        )}
      </div>
    </Modal>
  );
}

export function newBranchDialog(start?: string, startLabel?: string) {
  return openDialog<void>((done) => <NewBranchForm start={start} startLabel={startLabel} done={done} />);
}

export async function renameBranchDialog(oldName: string) {
  const name = await promptDialog({
    title: `重命名分支 ${oldName}`,
    label: '新名称',
    initial: oldName,
    okText: '重命名',
    validate: (v) => validateBranchName(v) ?? (v === oldName ? '名称未改变' : null),
  });
  if (name) await runOp(`重命名分支 ${oldName}`, () => api.renameBranch(oldName, name), { success: `已重命名为 ${name}` });
}

// ---------------------------------------------------------------------------

const RESET_MODES = [
  { mode: 'soft', label: 'Soft', desc: '文件不会更改，差异会被暂存以待提交。' },
  { mode: 'mixed', label: 'Mixed', desc: '文件不会更改，差异不会被暂存。' },
  { mode: 'hard', label: 'Hard', desc: '文件将还原到所选提交的状态。警告：本地更改将丢失。' },
  { mode: 'keep', label: 'Keep', desc: '文件将还原到所选提交的状态，但会保留本地更改。' },
];

export function resetDialog(hash: string, subject: string) {
  return openDialog<void>((done) => <ResetForm hash={hash} subject={subject} done={done} />);
}

function ResetForm({ hash, subject, done }: { hash: string; subject: string; done: () => void }) {
  const [mode, setMode] = useState('mixed');
  const branch = app.get().info?.head ?? 'HEAD';
  const submit = async () => {
    done();
    await runOp('重置', () => api.reset(hash, mode), { success: `已将 ${branch} 重置到 ${shortHash(hash)}` });
  };
  return (
    <Modal
      title="Git 重置"
      onClose={done}
      onSubmit={submit}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={done}>
            取消
          </button>
          <button className={cx('btn', mode === 'hard' ? 'danger' : 'primary')} onClick={submit}>
            重置
          </button>
        </>
      }
    >
      <p className="muted">
        将当前分支 <b>{branch}</b> 的 HEAD 重置到所选提交：
      </p>
      <div className="commit-chip">
        <GitCommitHorizontal size={14} /> <code>{shortHash(hash)}</code> {subject}
      </div>
      <div className="radio-list">
        {RESET_MODES.map((m) => (
          <label key={m.mode} className={cx('radio-card', mode === m.mode && 'active')}>
            <input type="radio" name="mode" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
            <div>
              <b>{m.label}</b>
              <div className="muted small">{m.desc}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function tagDialog(hash: string) {
  return openDialog<void>((done) => <TagForm hash={hash} done={done} />);
}

function TagForm({ hash, done }: { hash: string; done: () => void }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const exists = app.get().refs?.tags.some((t) => t.name === name);
  const err = validateBranchName(name) ?? (exists ? `标签 “${name}” 已存在` : null);
  const submit = async () => {
    if (err) return;
    done();
    await runOp(`创建标签 ${name}`, () => api.createTag(name, hash, message.trim() || undefined), { success: `已创建标签 ${name}` });
  };
  return (
    <Modal
      title={`在 ${shortHash(hash)} 上新建标签`}
      onClose={done}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={done}>
            取消
          </button>
          <button className="btn primary" disabled={!!err} onClick={submit}>
            创建标签
          </button>
        </>
      }
    >
      <div className="form">
        <label className="form-label">标签名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 v1.0.0" />
        {name && err && <div className="form-error">{err}</div>}
        <label className="form-label">消息（可选，填写后创建附注标签）</label>
        <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function stashDialog(paths?: string[]) {
  return openDialog<void>((done) => <StashForm paths={paths} done={done} />);
}

function StashForm({ paths, done }: { paths?: string[]; done: () => void }) {
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(getPref('stash.untracked', true));
  const [keepIndex, setKeepIndex] = useState(false);
  const branch = app.get().info?.head ?? 'HEAD';
  const submit = async () => {
    setPref('stash.untracked', untracked);
    done();
    await runOp(
      '储藏更改',
      () => api.stashSave({ message: message.trim() || undefined, includeUntracked: untracked, keepIndex, paths }),
      { success: (r) => (/No local changes/i.test(r.output) ? '没有可储藏的本地更改' : '已储藏本地更改') },
    );
  };
  return (
    <Modal
      title="储藏更改"
      onClose={done}
      onSubmit={submit}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={done}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            创建储藏
          </button>
        </>
      }
    >
      <div className="form">
        <div className="muted">
          当前分支：<b>{branch}</b>
          {paths?.length ? `，仅储藏选中的 ${paths.length} 个文件` : ''}
        </div>
        <label className="form-label">消息</label>
        <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="（可选）" />
        <label className="check">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> 包含未跟踪的文件
        </label>
        <label className="check">
          <input type="checkbox" checked={keepIndex} onChange={(e) => setKeepIndex(e.target.checked)} /> 保留暂存区（--keep-index）
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function pushDialog(branch?: string) {
  return openDialog<void>((done) => <PushForm branch={branch} done={done} />);
}

function PushForm(props: { branch?: string; done: () => void }) {
  const info = app.get().info!;
  const refs = app.get().refs;
  const branch = props.branch ?? info.head ?? '';
  const local = refs?.local.find((b) => b.name === branch);
  const upstream = local?.upstream ?? null;
  const slash = upstream ? upstream.indexOf('/') : -1;
  const [remote, setRemote] = useState(upstream && slash > 0 ? upstream.slice(0, slash) : info.remotes[0]?.name ?? '');
  const [target, setTarget] = useState(upstream && slash > 0 ? upstream.slice(slash + 1) : branch);
  const [force, setForce] = useState(false);
  const [tags, setTags] = useState(false);
  const [setUp, setSetUp] = useState(!upstream);
  const [preview, setPreview] = useState<{ commits: Commit[]; newBranch: boolean; behind: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!remote || !branch || !target) return;
    let alive = true;
    setPreview(null);
    setError(null);
    api
      .pushPreview(remote, branch, target)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [remote, branch, target]);

  const submit = async () => {
    if (!remote || !branch || !target) return;
    props.done();
    const doPush = (f: false | 'lease') =>
      runOp(`推送 ${branch}`, () => api.push({ remote, branch, remoteBranch: target, force: f, setUpstream: setUp, tags }), {
        success: (r) => (/Everything up-to-date/i.test(r.output) ? '已是最新，无需推送' : `已推送 ${branch} 到 ${remote}/${target}`),
      });
    const r = await doPush(force ? 'lease' : false);
    if (r && !r.ok && r.rejected) {
      const choice = await confirmDialog({
        title: '推送被拒绝',
        message: (
          <>
            <p>
              推送 <b>{branch}</b> 被拒绝，远程分支 <b>{`${remote}/${target}`}</b> 包含本地没有的提交。
            </p>
            <p>请先更新本地分支，然后重新推送。</p>
            <pre className="output-pre small">{r.output}</pre>
          </>
        ),
        okText: '合并并推送',
        extra: { label: '变基并推送', value: 'rebase' },
      });
      if (!choice) return;
      const pulled = await runOp('更新', () => api.pull(choice === 'rebase' ? 'rebase' : 'merge', remote, target));
      if (pulled?.ok) await doPush(false);
    }
  };

  const remotes = info.remotes;
  return (
    <Modal
      title={`推送提交到 ${info.name}`}
      onClose={props.done}
      onSubmit={submit}
      width={640}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} /> 推送标签
          </label>
          <label className="check">
            <input type="checkbox" checked={setUp} onChange={(e) => setSetUp(e.target.checked)} /> 设置上游
          </label>
          <label className={cx('check', force && 'c-error')}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 强制推送（--force-with-lease）
          </label>
          <span className="spacer" />
          <button className="btn" onClick={props.done}>
            取消
          </button>
          <button className={cx('btn', force ? 'danger' : 'primary')} disabled={!remote} onClick={submit}>
            {force ? '强制推送' : '推送'}
          </button>
        </>
      }
    >
      {remotes.length === 0 ? (
        <div className="empty-hint">
          此仓库还没有配置远程仓库。
          <button className="link-btn" onClick={() => (props.done(), remotesDialog())}>
            管理远程仓库…
          </button>
        </div>
      ) : (
        <>
          <div className="push-target">
            <GitBranch size={14} /> <b>{branch}</b>
            <span className="muted">→</span>
            <select className="input select" value={remote} onChange={(e) => setRemote(e.target.value)}>
              {remotes.map((r) => (
                <option key={r.name}>{r.name}</option>
              ))}
            </select>
            <span className="muted">:</span>
            <input className="input" style={{ width: 200 }} value={target} onChange={(e) => setTarget(e.target.value)} />
            {preview?.newBranch && <span className="badge new">新分支</span>}
          </div>
          <div className="push-commits">
            {error && <div className="form-error">{error}</div>}
            {!preview && !error && <div className="muted pad">正在计算要推送的提交…</div>}
            {preview && preview.commits.length === 0 && <div className="muted pad">没有要推送的提交</div>}
            {preview?.commits.map((c) => (
              <div key={c.hash} className="push-commit">
                <GitCommitHorizontal size={13} className="muted" />
                <span className="ellipsis">{c.subject}</span>
                <span className="muted small nowrap">
                  {c.authorName} · {formatDate(c.authorDate)}
                </span>
                <code className="muted small">{shortHash(c.hash)}</code>
              </div>
            ))}
          </div>
          {preview && preview.behind > 0 && (
            <div className="warn-box">远程分支领先本地 {preview.behind} 个提交，普通推送将被拒绝，可先拉取更新。</div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function pullDialog() {
  return openDialog<void>((done) => <PullForm done={done} />);
}

function PullForm({ done }: { done: () => void }) {
  const info = app.get().info!;
  const refs = app.get().refs;
  const upstream = info.upstream;
  const slash = upstream ? upstream.indexOf('/') : -1;
  const [remote, setRemote] = useState(upstream && slash > 0 ? upstream.slice(0, slash) : info.remotes[0]?.name ?? '');
  const branches = useMemo(
    () => (refs?.remote ?? []).filter((b) => b.name.startsWith(remote + '/')).map((b) => b.name.slice(remote.length + 1)),
    [refs, remote],
  );
  const [branch, setBranch] = useState(upstream && slash > 0 ? upstream.slice(slash + 1) : info.head ?? '');
  const [mode, setMode] = useState<'merge' | 'rebase' | 'ff-only'>(getPref('pull.mode', 'merge'));
  const submit = async () => {
    setPref('pull.mode', mode);
    done();
    await runOp(`拉取 ${remote}/${branch}`, () => api.pull(mode, remote, branch), {
      success: (r) => (/Already up to date/i.test(r.output) ? '已是最新' : '拉取成功'),
    });
  };
  return (
    <Modal
      title={`拉取到 ${info.head ?? 'HEAD'}`}
      onClose={done}
      onSubmit={submit}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={done}>
            取消
          </button>
          <button className="btn primary" disabled={!remote || !branch} onClick={submit}>
            拉取
          </button>
        </>
      }
    >
      <div className="form">
        <div className="form-row">
          <select className="input select" value={remote} onChange={(e) => setRemote(e.target.value)}>
            {info.remotes.map((r) => (
              <option key={r.name}>{r.name}</option>
            ))}
          </select>
          <select className="input select grow" value={branch} onChange={(e) => setBranch(e.target.value)}>
            {!branches.includes(branch) && <option value={branch}>{branch}</option>}
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
        <div className="radio-list">
          {(
            [
              ['merge', '合并', '将远程更改合并到当前分支（git pull --no-rebase）'],
              ['rebase', '变基', '将本地提交变基到远程更改之上（git pull --rebase）'],
              ['ff-only', '仅快进', '仅在可以快进时更新（git pull --ff-only）'],
            ] as const
          ).map(([m, label, desc]) => (
            <label key={m} className={cx('radio-card', mode === m && 'active')}>
              <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
              <div>
                <b>{label}</b>
                <div className="muted small">{desc}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="muted small">本地未提交的更改会自动储藏并在拉取后恢复（--autostash）。</div>
      </div>
    </Modal>
  );
}

/** IDEA "Update Project": pull the current branch's upstream. */
export async function updateProject() {
  const info = app.get().info;
  if (!info) return;
  if (!info.upstream) {
    if (!info.remotes.length) {
      await confirmDialog({ title: '无法更新', message: '当前分支没有上游分支，且仓库未配置远程仓库。', okText: '知道了' });
      return;
    }
    return pullDialog();
  }
  const mode = getPref<'merge' | 'rebase' | 'ff-only'>('pull.mode', 'merge');
  await runOp('更新项目', () => api.pull(mode), {
    success: (r) => (/Already up to date|已经是最新/i.test(r.output) ? '所有文件都是最新的' : '项目已更新'),
  });
}

// ---------------------------------------------------------------------------

export async function editHeadMessageDialog() {
  const current = await api.commitMessage('HEAD');
  const msg = await promptDialog({ title: '编辑提交消息', initial: current, multiline: true, okText: '保存' });
  if (msg && msg !== current) {
    await runOp('编辑提交消息', () => api.commitChanges({ message: msg, amend: true, only: true }), {
      success: '提交消息已更新',
    });
  }
}

export async function checkoutRevisionDialog() {
  const rev = await promptDialog({
    title: '签出标签或修订',
    label: '输入提交哈希、标签或任意引用',
    placeholder: '例如 v1.0.0 或 a1b2c3d',
    okText: '签出',
  });
  if (rev) await checkoutRevision(rev.trim());
}

// ---------------------------------------------------------------------------

export function remotesDialog() {
  return openDialog<void>((done) => <RemotesForm done={done} />);
}

function RemotesForm({ done }: { done: () => void }) {
  const [remotes, setRemotes] = useState(app.get().info?.remotes ?? []);
  const reload = async () => {
    await refreshInfo();
    setRemotes(app.get().info?.remotes ?? []);
  };
  const add = async () => {
    const name = await promptDialog({ title: '添加远程仓库', label: '名称', initial: remotes.length ? '' : 'origin' });
    if (!name) return;
    const url = await promptDialog({ title: `添加远程仓库 ${name}`, label: 'URL', placeholder: 'https://… 或 git@…' });
    if (!url) return;
    await runOp('添加远程仓库', () => api.addRemote(name.trim(), url.trim()), { success: `已添加 ${name}` });
    await reload();
  };
  const edit = async (name: string, url: string) => {
    const nu = await promptDialog({ title: `编辑远程仓库 ${name}`, label: 'URL', initial: url });
    if (!nu || nu === url) return;
    await runOp('修改远程仓库', () => api.setRemoteUrl(name, nu.trim()), { success: '已更新' });
    await reload();
  };
  const remove = async (name: string) => {
    const ok = await confirmDialog({ title: '移除远程仓库', message: `确定要移除远程仓库 “${name}” 吗？`, okText: '移除', danger: true });
    if (!ok) return;
    await runOp('移除远程仓库', () => api.removeRemote(name), { success: `已移除 ${name}` });
    await reload();
  };
  return (
    <Modal
      title="Git 远程仓库"
      onClose={done}
      width={620}
      footer={
        <>
          <button className="btn" onClick={add}>
            <Plus size={14} /> 添加
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={done}>
            关闭
          </button>
        </>
      }
    >
      <div className="list-box">
        {remotes.length === 0 && <div className="muted pad">没有远程仓库</div>}
        {remotes.map((r) => (
          <div key={r.name} className="list-row">
            <b>{r.name}</b>
            <span className="ellipsis muted grow">{r.fetchUrl}</span>
            <button className="icon-btn" title="编辑" onClick={() => edit(r.name, r.fetchUrl)}>
              <Pencil size={14} />
            </button>
            <button className="icon-btn" title="移除" onClick={() => remove(r.name)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export async function deleteTagDialog(name: string) {
  const remotes = app.get().info?.remotes ?? [];
  const r = await confirmDialog({
    title: '删除标签',
    message: `确定要删除标签 “${name}” 吗？`,
    okText: '删除',
    danger: true,
    extra: remotes.length ? { label: `同时从 ${remotes[0].name} 删除`, value: 'remote' } : undefined,
  });
  if (!r) return;
  await runOp(`删除标签 ${name}`, () => api.deleteTag(name), { success: `已删除标签 ${name}` });
  if (r === 'remote') await runOp('删除远程标签', () => api.deleteRemoteTag(remotes[0].name, name), { success: '已删除远程标签' });
}
