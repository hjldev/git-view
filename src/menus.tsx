import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cherry,
  Copy,
  Eye,
  GitBranch,
  GitCompare,
  GitMerge,
  Pencil,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { Commit } from '../shared/types';
import { api } from './api';
import {
  checkoutAndRebase,
  checkoutBranch,
  checkoutRevision,
  cherryPick,
  deleteBranch,
  deleteRemoteBranch,
  mergeIntoCurrent,
  openTab,
  rebaseCurrentOnto,
  revertCommits,
  runOp,
  showInLog,
} from './actions';
import {
  deleteTagDialog,
  editHeadMessageDialog,
  newBranchDialog,
  pushDialog,
  renameBranchDialog,
  resetDialog,
  tagDialog,
  updateProject,
} from './dialogs/dialogs';
import { app } from './store';
import type { MenuEntry } from './ui/ContextMenu';
import { confirmDialog } from './ui/Dialog';
import { toast } from './ui/Toasts';
import { copyText, shortHash } from './util';

const ic = (C: typeof Copy) => <C size={14} />;

export function localBranchMenu(name: string): MenuEntry[] {
  const info = app.get().info;
  const cur = info?.head ?? null;
  const isCurrent = name === cur;
  const local = app.get().refs?.local.find((b) => b.name === name);
  if (isCurrent) {
    return [
      { header: `分支 ${name}` },
      { label: `从 '${name}' 新建分支…`, icon: ic(Plus), onClick: () => newBranchDialog(name, name) },
      { label: '更新', icon: ic(ArrowDownToLine), onClick: () => updateProject() },
      { label: '推送…', icon: ic(ArrowUpFromLine), onClick: () => pushDialog(name) },
      'sep',
      { label: '仅在日志中显示此分支', icon: ic(Eye), onClick: () => showInLog({ branches: [name] }) },
      { label: '重命名…', icon: ic(Pencil), onClick: () => renameBranchDialog(name) },
    ];
  }
  return [
    { header: `分支 ${name}` },
    { label: '检出', icon: ic(GitBranch), onClick: () => checkoutBranch(name) },
    { label: `从 '${name}' 新建分支…`, icon: ic(Plus), onClick: () => newBranchDialog(name, name) },
    cur && { label: `检出并变基到 '${cur}'`, onClick: () => checkoutAndRebase(name) },
    'sep',
    cur && { label: `与 '${cur}' 比较`, icon: ic(GitCompare), onClick: () => openTab({ type: 'compare', a: name, b: cur }) },
    { label: '显示与工作树的差异', onClick: () => openTab({ type: 'compareFiles', from: name, to: 'WORKTREE' }) },
    'sep',
    cur && { label: `将 '${cur}' 变基到 '${name}'`, onClick: () => rebaseCurrentOnto(name) },
    { label: `将 '${name}' 合并到 '${cur ?? 'HEAD'}'`, icon: ic(GitMerge), onClick: () => mergeIntoCurrent(name) },
    'sep',
    { label: '推送…', icon: ic(ArrowUpFromLine), hint: local?.upstream ?? undefined, onClick: () => pushDialog(name) },
    { label: '仅在日志中显示此分支', icon: ic(Eye), onClick: () => showInLog({ branches: [name] }) },
    { label: '重命名…', icon: ic(Pencil), onClick: () => renameBranchDialog(name) },
    { label: '删除', icon: ic(Trash2), danger: true, onClick: () => deleteBranch(name) },
  ];
}

export function remoteBranchMenu(name: string): MenuEntry[] {
  const cur = app.get().info?.head ?? null;
  const slash = name.indexOf('/');
  const remote = name.slice(0, slash);
  const branch = name.slice(slash + 1);
  return [
    { header: `远程分支 ${name}` },
    { label: '检出', icon: ic(GitBranch), onClick: () => checkoutBranch(name, true) },
    { label: `从 '${name}' 新建分支…`, icon: ic(Plus), onClick: () => newBranchDialog(name, name) },
    'sep',
    cur && { label: `与 '${cur}' 比较`, icon: ic(GitCompare), onClick: () => openTab({ type: 'compare', a: name, b: cur }) },
    { label: '显示与工作树的差异', onClick: () => openTab({ type: 'compareFiles', from: name, to: 'WORKTREE' }) },
    'sep',
    cur && { label: `将 '${cur}' 变基到 '${name}'`, onClick: () => rebaseCurrentOnto(name) },
    { label: `将 '${name}' 合并到 '${cur ?? 'HEAD'}'`, icon: ic(GitMerge), onClick: () => mergeIntoCurrent(name) },
    cur && {
      label: `使用变基拉取到 '${cur}'`,
      onClick: () => runOp(`拉取 ${name}`, () => api.pull('rebase', remote, branch), { success: '拉取成功' }),
    },
    cur && {
      label: `使用合并拉取到 '${cur}'`,
      onClick: () => runOp(`拉取 ${name}`, () => api.pull('merge', remote, branch), { success: '拉取成功' }),
    },
    'sep',
    { label: '仅在日志中显示此分支', icon: ic(Eye), onClick: () => showInLog({ branches: [name] }) },
    { label: '删除', icon: ic(Trash2), danger: true, onClick: () => deleteRemoteBranch(name) },
  ];
}

export function tagMenu(name: string): MenuEntry[] {
  const remotes = app.get().info?.remotes ?? [];
  return [
    { header: `标签 ${name}` },
    { label: '检出标签', icon: ic(GitBranch), onClick: () => checkoutRevision(name) },
    { label: `从 '${name}' 新建分支…`, icon: ic(Plus), onClick: () => newBranchDialog(name, name) },
    { label: `将 '${name}' 合并到当前分支`, icon: ic(GitMerge), onClick: () => mergeIntoCurrent(name) },
    'sep',
    ...remotes.map(
      (r): MenuEntry => ({
        label: `推送到 ${r.name}`,
        icon: ic(ArrowUpFromLine),
        onClick: () => runOp(`推送标签 ${name}`, () => api.pushTag(r.name, name), { success: `已推送标签 ${name}` }),
      }),
    ),
    { label: '复制名称', icon: ic(Copy), onClick: () => copyText(name) },
    { label: '删除', icon: ic(Trash2), danger: true, onClick: () => deleteTagDialog(name) },
  ];
}

/** Context menu for one or more selected commits in the log. */
export function commitMenu(commits: Commit[]): MenuEntry[] {
  const c = commits[0];
  const single = commits.length === 1;
  const info = app.get().info;
  const isHead = single && c.hash === info?.headHash;
  const hashes = commits.map((x) => x.hash);
  const branchRefs = single ? c.refs.filter((r) => r.type === 'local' || r.type === 'remote' || r.type === 'tag') : [];

  return [
    { label: '复制修订号', icon: ic(Copy), hint: single ? shortHash(c.hash) : `${commits.length} 个`, onClick: () => copyText(hashes.join(' ')) },
    single && { label: '复制提交消息', onClick: () => copyText(c.subject) },
    'sep',
    { label: '优选', icon: ic(Cherry), onClick: () => cherryPick(hashes) },
    'sep',
    single && { label: '签出修订', onClick: () => checkoutRevision(c.hash) },
    single && {
      label: '与本地比较',
      icon: ic(GitCompare),
      onClick: () => openTab({ type: 'compareFiles', from: c.hash, to: 'WORKTREE' }),
    },
    commits.length === 2 && {
      label: '比较两个提交',
      icon: ic(GitCompare),
      onClick: () => openTab({ type: 'compareFiles', from: commits[1].hash, to: commits[0].hash }),
    },
    'sep',
    single && { label: '将当前分支重置到此处…', icon: ic(RotateCcw), onClick: () => resetDialog(c.hash, c.subject) },
    { label: '还原提交', icon: ic(Undo2), onClick: () => revertCommits(hashes) },
    isHead && {
      label: '撤销提交…',
      onClick: async () => {
        const ok = await confirmDialog({
          title: '撤销提交',
          message: '将撤销最后一次提交，提交中的更改会保留在暂存区。如果该提交已推送，不建议执行此操作。',
          okText: '撤销提交',
        });
        if (ok) {
          await runOp('撤销提交', () => api.undoCommit(), { success: '已撤销最后一次提交' });
          const msg = c.subject;
          if (!app.get().commitMessage) app.set({ commitMessage: msg, leftPanel: 'commit' });
          toast({ type: 'info', title: '原提交消息已放入提交框' });
        }
      },
    },
    isHead && { label: '编辑提交消息…', icon: ic(Pencil), onClick: () => editHeadMessageDialog() },
    'sep',
    single && { label: '新建分支…', icon: ic(GitBranch), onClick: () => newBranchDialog(c.hash, shortHash(c.hash)) },
    single && { label: '新建标签…', icon: ic(Tag), onClick: () => tagDialog(c.hash) },
    branchRefs.length > 0 && 'sep',
    ...branchRefs.map(
      (r): MenuEntry => ({
        label: r.type === 'tag' ? `标签 '${r.name}'` : r.type === 'remote' ? `远程分支 '${r.name}'` : `分支 '${r.name}'`,
        icon: r.type === 'tag' ? ic(Tag) : ic(GitBranch),
        submenu: (r.type === 'tag' ? tagMenu(r.name) : r.type === 'remote' ? remoteBranchMenu(r.name) : localBranchMenu(r.name)).filter(
          (x) => !(x && typeof x === 'object' && 'header' in x),
        ),
      }),
    ),
  ];
}
