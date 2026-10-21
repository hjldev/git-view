import type { DiffSpec } from '../shared/types';
import { api, ApiError, setApiRepo, type Op } from './api';
import { app, emptyFilter, LOG_TAB, type TabView } from './store';
import { confirmDialog, messageDialog } from './ui/Dialog';
import { toast } from './ui/Toasts';
import { basename, shortHash } from './util';

// ---------------------------------------------------------------------------
// Refreshing

function coalesce(fn: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        await fn();
      } catch (e) {
        console.warn(e);
      } finally {
        running = null;
        if (again) {
          again = false;
          void run();
        }
      }
    })();
    return running;
  };
  return run;
}

export const refreshInfo = coalesce(async () => {
  if (!app.get().repoPath) return;
  app.set({ info: await api.info() });
});

export const refreshStatus = coalesce(async () => {
  if (!app.get().repoPath) return;
  app.set({ status: await api.status() });
});

export const refreshRefs = coalesce(async () => {
  if (!app.get().repoPath) return;
  app.set({ refs: await api.refs() });
});

export const refreshStashes = coalesce(async () => {
  if (!app.get().repoPath) return;
  app.set({ stashes: await api.stashes() });
});

export function bumpLog() {
  app.set((s) => ({ logVersion: s.logVersion + 1 }));
}

export async function refreshAll() {
  bumpLog();
  await Promise.all([refreshInfo(), refreshStatus(), refreshRefs(), refreshStashes()]);
}

let events: EventSource | null = null;

function connectEvents(root: string) {
  events?.close();
  events = new EventSource(`/api/events?repo=${encodeURIComponent(root)}`);
  events.addEventListener('change', (e) => {
    const { kinds } = JSON.parse((e as MessageEvent).data) as { kinds: string[] };
    if (kinds.includes('refs')) {
      void refreshInfo();
      void refreshRefs();
      void refreshStashes();
      bumpLog();
    }
    void refreshStatus();
  });
}

export async function openRepo(path: string) {
  const info = await api.open(path);
  setApiRepo(info.root);
  app.set({
    repoPath: info.root,
    info,
    status: null,
    refs: null,
    stashes: [],
    tabs: [],
    activeTab: LOG_TAB,
    logFilter: emptyFilter,
    reveal: null,
    commitMessage: '',
    amend: false,
  });
  const url = new URL(location.href);
  url.searchParams.set('repo', info.root);
  history.replaceState(null, '', url);
  document.title = `${info.name} - Git View`;
  connectEvents(info.root);
  await refreshAll();
}

export function closeRepo() {
  events?.close();
  events = null;
  setApiRepo(null);
  app.set({ repoPath: null, info: null, status: null, refs: null, stashes: [], tabs: [], activeTab: LOG_TAB });
  const url = new URL(location.href);
  url.searchParams.delete('repo');
  history.replaceState(null, '', url);
  document.title = 'Git View';
}

// ---------------------------------------------------------------------------
// Running operations

let taskSeq = 0;

export function showError(title: string, e: unknown) {
  const err = e as ApiError;
  const msg = err?.message ?? String(e);
  const lines = msg.split('\n').filter((l) => l.trim());
  toast({
    type: 'error',
    title,
    message: lines.slice(0, 4).join('\n') + (lines.length > 4 ? '\n…' : ''),
    actions: [
      {
        label: '查看详情',
        onClick: () => void messageDialog(title, err?.command ? `命令: ${err.command}` : '', err?.stderr || msg),
      },
    ],
  });
}

export interface RunOptions {
  success?: string | ((r: Op) => string | null);
  refresh?: boolean;
}

/**
 * Runs a git operation with a background-task indicator, error reporting and a
 * refresh afterwards. Returns the result, or null when it threw.
 */
export async function runOp(title: string, fn: () => Promise<Op>, o: RunOptions = {}): Promise<Op | null> {
  const id = ++taskSeq;
  app.set((s) => ({ tasks: [...s.tasks, { id, title }] }));
  try {
    const r = await fn();
    if (r && !r.ok && r.conflicts) {
      toast({
        type: 'warn',
        title: `${title}：存在冲突`,
        message: '请解决冲突后继续。',
        actions: [{ label: '解决冲突…', onClick: () => void showConflicts() }],
      });
      void refreshStatus().then(() => showConflicts());
    } else if (r?.ok && o.success) {
      const text = typeof o.success === 'function' ? o.success(r) : o.success;
      if (text) toast({ type: 'success', title: text, message: undefined });
    }
    return r;
  } catch (e) {
    showError(`${title}失败`, e);
    return null;
  } finally {
    app.set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    if (o.refresh !== false) void refreshAll();
  }
}

export async function showConflicts() {
  const { ConflictsDialog } = await import('./dialogs/ConflictsDialog');
  await ConflictsDialog();
}

// ---------------------------------------------------------------------------
// Tabs

function tabId(view: TabView): string {
  if (view.type === 'diff') return 'diff:' + JSON.stringify(view.specs[view.index]);
  return `${view.type}:${JSON.stringify(view)}`;
}

export function diffTitle(spec: DiffSpec): { title: string; tooltip: string } {
  const p = 'path' in spec && spec.path ? spec.path : '';
  const name = p ? basename(p) : '全部更改';
  let suffix = '';
  switch (spec.kind) {
    case 'commit':
      suffix = shortHash(spec.hash);
      break;
    case 'staged':
      suffix = '已暂存';
      break;
    case 'unstaged':
      suffix = '本地更改';
      break;
    case 'untracked':
      suffix = '新文件';
      break;
    case 'stash':
      suffix = `stash@{${spec.index}}`;
      break;
    case 'refs':
      suffix = `${spec.from.length === 40 ? shortHash(spec.from) : spec.from} ↔ ${spec.to.length === 40 ? shortHash(spec.to) : spec.to}`;
      break;
    case 'worktree-vs-ref':
      suffix = `${spec.ref} ↔ 本地`;
      break;
  }
  return { title: `${name} (${suffix})`, tooltip: p };
}

function viewTitle(view: TabView): { title: string; tooltip?: string } {
  switch (view.type) {
    case 'diff':
      return diffTitle(view.specs[view.index]);
    case 'blame':
      return { title: `注解: ${basename(view.path)}`, tooltip: view.path };
    case 'history':
      return { title: `历史: ${basename(view.path)}`, tooltip: view.path };
    case 'compare':
      return { title: `比较 ${view.a} ↔ ${view.b}` };
    case 'compareFiles':
      return { title: `差异 ${view.from} ↔ ${view.to === 'WORKTREE' ? '本地' : view.to}` };
    case 'merge':
      return { title: `合并: ${basename(view.path)}`, tooltip: view.path };
  }
}

export function openTab(view: TabView, o: { preview?: boolean } = {}) {
  const id = tabId(view);
  const { title, tooltip } = viewTitle(view);
  const s = app.get();
  const existing = s.tabs.find((t) => t.id === id);
  if (existing) {
    app.set({
      activeTab: id,
      tabs: o.preview ? s.tabs : s.tabs.map((t) => (t.id === id ? { ...t, preview: false, view } : t)),
    });
    return;
  }
  const tab = { id, title, tooltip, view, preview: !!o.preview };
  let tabs = [...s.tabs];
  const previewIdx = o.preview ? tabs.findIndex((t) => t.preview) : -1;
  if (previewIdx >= 0) tabs[previewIdx] = tab;
  else tabs.push(tab);
  if (tabs.length > 24) tabs = tabs.slice(tabs.length - 24);
  app.set({ tabs, activeTab: id });
}

/** Replaces the view of an existing tab (e.g. next/previous file in a diff). */
export function updateTab(oldId: string, view: TabView) {
  const id = tabId(view);
  const { title, tooltip } = viewTitle(view);
  app.set((s) => {
    if (s.tabs.some((t) => t.id === id && t.id !== oldId)) {
      return { tabs: s.tabs.filter((t) => t.id !== oldId), activeTab: id };
    }
    return {
      tabs: s.tabs.map((t) => (t.id === oldId ? { ...t, id, title, tooltip, view } : t)),
      activeTab: s.activeTab === oldId ? id : s.activeTab,
    };
  });
}

export function closeTab(id: string) {
  app.set((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return {};
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeTab = s.activeTab;
    if (activeTab === id) activeTab = tabs[Math.min(idx, tabs.length - 1)]?.id ?? LOG_TAB;
    return { tabs, activeTab };
  });
}

export function pinTab(id: string) {
  app.set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) }));
}

export function openDiff(specs: DiffSpec[], index = 0, preview = true) {
  if (!specs.length) return;
  openTab({ type: 'diff', specs, index }, { preview });
}

export function revealCommit(hash: string) {
  app.set((s) => ({ activeTab: LOG_TAB, reveal: { hash, seq: (s.reveal?.seq ?? 0) + 1 } }));
}

export function showInLog(filter: Partial<typeof emptyFilter>) {
  app.set({ activeTab: LOG_TAB, logFilter: { ...emptyFilter, ...filter } });
}

// ---------------------------------------------------------------------------
// Branch operations shared by the branch popup, branch tree and log

const currentBranch = () => app.get().info?.head ?? null;

export async function checkoutBranch(name: string, remote = false) {
  const title = `检出 ${name}`;
  let r = await runOp(title, () => api.checkout(name, { remote }), { success: `已检出 ${name}` });
  if (r && !r.ok && r.localChanges) {
    const ok = await confirmDialog({
      title: 'Git 检出问题',
      message: (
        <>
          <p>以下本地更改会被检出操作覆盖：</p>
          <pre className="output-pre small">{r.output}</pre>
          <p>智能检出会先储藏本地更改，检出后再恢复它们。</p>
        </>
      ),
      okText: '智能检出',
      cancelText: '不检出',
    });
    if (ok) r = await runOp(title, () => api.checkout(name, { remote, smart: true }), { success: `已检出 ${name}` });
  }
}

export async function deleteBranch(name: string) {
  const ok = await confirmDialog({ title: '删除分支', message: `确定要删除本地分支 “${name}” 吗？`, okText: '删除', danger: true });
  if (!ok) return;
  let r = await runOp(`删除分支 ${name}`, () => api.deleteBranch(name));
  if (r && !r.ok && r.notMerged) {
    const force = await confirmDialog({
      title: '分支未完全合并',
      message: `分支 “${name}” 包含尚未合并到当前分支的提交。仍要删除吗？`,
      okText: '强制删除',
      danger: true,
    });
    if (!force) return;
    r = await runOp(`删除分支 ${name}`, () => api.deleteBranch(name, true));
  }
  if (r?.ok && r.hash) {
    const hash = r.hash;
    toast({
      type: 'success',
      title: `已删除分支 ${name}`,
      actions: [{ label: '恢复', onClick: () => void runOp(`恢复分支 ${name}`, () => api.createBranch(name, hash, false)) }],
    });
  }
}

export async function deleteRemoteBranch(name: string) {
  const ok = await confirmDialog({
    title: '删除远程分支',
    message: `确定要从远程仓库删除分支 “${name}” 吗？此操作会影响其他协作者。`,
    okText: '删除',
    danger: true,
  });
  if (ok) await runOp(`删除远程分支 ${name}`, () => api.deleteRemoteBranch(name), { success: `已删除远程分支 ${name}` });
}

export async function mergeIntoCurrent(ref: string) {
  const cur = currentBranch() ?? 'HEAD';
  await runOp(`合并 ${ref} 到 ${cur}`, () => api.merge(ref), { success: (r) => (/Already up to date/i.test(r.output) ? '已是最新' : `已将 ${ref} 合并到 ${cur}`) });
}

export async function rebaseCurrentOnto(ref: string) {
  const cur = currentBranch() ?? 'HEAD';
  await runOp(`将 ${cur} 变基到 ${ref}`, () => api.rebase(ref), { success: `已将 ${cur} 变基到 ${ref}` });
}

export async function checkoutAndRebase(branch: string) {
  const cur = currentBranch();
  if (!cur) return;
  await runOp(`检出 ${branch} 并变基到 ${cur}`, () => api.rebase(cur, branch), { success: `已将 ${branch} 变基到 ${cur}` });
}

export async function fetchAll() {
  await runOp('获取', () => api.fetch(), {
    success: (r) => (r.output.trim() ? '获取成功' : '获取成功：没有新内容'),
  });
}

export async function cherryPick(hashes: string[]) {
  await runOp('优选', () => api.cherryPick([...hashes].reverse()), {
    success: `已优选 ${hashes.length} 个提交`,
  });
}

export async function revertCommits(hashes: string[]) {
  await runOp('还原提交', () => api.revert(hashes), { success: `已还原 ${hashes.length} 个提交` });
}

export async function checkoutRevision(hash: string) {
  await runOp(`检出修订 ${shortHash(hash)}`, () => api.checkoutRevision(hash), {
    success: `已检出 ${shortHash(hash)}（游离 HEAD）`,
  });
}

export async function sequenceControl(action: 'continue' | 'abort' | 'skip') {
  const label = { continue: '继续', abort: '中止', skip: '跳过' }[action];
  if (action === 'abort') {
    const ok = await confirmDialog({ title: `${label}操作`, message: '确定要中止当前操作吗？已解决的冲突将会丢失。', okText: '中止', danger: true });
    if (!ok) return;
  }
  await runOp(label, () => api.sequence(action), { success: `已${label}` });
}
