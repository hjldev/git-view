import type {
  Author,
  BlameResult,
  ChangedFile,
  Commit,
  CommitDetail,
  ConflictVersions,
  DiffSpec,
  FileDiff,
  FsListing,
  LogQuery,
  LogResult,
  OpResult,
  RecentRepo,
  RefsResult,
  RepoInfo,
  StashEntry,
  WorkingStatus,
} from '../shared/types';

export class ApiError extends Error {
  command?: string;
  stderr?: string;
  constructor(message: string, command?: string, stderr?: string) {
    super(message);
    this.command = command;
    this.stderr = stderr;
  }
}

let currentRepo: string | null = null;
export function setApiRepo(p: string | null) {
  currentRepo = p;
}

export async function call<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: currentRepo, ...body }),
  });
  let json: { data?: T; error?: string; command?: string; stderr?: string };
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`服务器无响应 (${res.status})`);
  }
  if (!res.ok) throw new ApiError(json.error ?? `请求失败 (${res.status})`, json.command, json.stderr);
  return json.data as T;
}

export type Op = OpResult & { localChanges?: boolean; notMerged?: boolean; rejected?: boolean; hash?: string };

export const api = {
  recent: () => call<RecentRepo[]>('repo.recent'),
  removeRecent: (path: string) => call<boolean>('repo.removeRecent', { path }),
  open: (path: string) => call<RepoInfo>('repo.open', { path }),
  init: (path: string) => call<RepoInfo>('repo.init', { path }),
  clone: (url: string, parent: string, name: string) => call<RepoInfo>('repo.clone', { url, parent, name }),
  listDir: (path?: string) => call<FsListing>('fs.list', { path }),
  info: () => call<RepoInfo>('repo.info'),

  log: (query: LogQuery) => call<LogResult>('log', { query }),
  authors: () => call<Author[]>('log.authors'),
  commit: (hash: string) => call<CommitDetail>('commit.detail', { hash }),
  commitBranches: (hash: string) => call<string[]>('commit.branches', { hash }),
  commitMessage: (hash = 'HEAD') => call<string>('commit.message', { hash }),
  status: () => call<WorkingStatus>('status'),
  refs: () => call<RefsResult>('refs'),
  diff: (spec: DiffSpec, ignoreWs = false, context = 100000) => call<FileDiff[]>('diff', { spec, ignoreWs, context }),
  diffFiles: (from: string, to: string) => call<ChangedFile[]>('diff.files', { from, to }),
  fileContent: (path: string, rev?: string) => call<string>('file.content', { path, rev }),
  blame: (path: string, rev?: string, ignoreWs = false) => call<BlameResult>('blame', { path, rev, ignoreWs }),
  fileHistory: (path: string) =>
    call<(Commit & { path: string; oldPath?: string; status: string })[]>('file.history', { path }),
  compare: (a: string, b: string) => call<{ onlyA: Commit[]; onlyB: Commit[] }>('branch.compare', { a, b }),
  pushPreview: (remote: string, branch: string, remoteBranch: string) =>
    call<{ commits: Commit[]; newBranch: boolean; behind: number }>('push.preview', { remote, branch, remoteBranch }),
  stashes: () => call<StashEntry[]>('stash.list'),
  stashFiles: (index: number) => call<(ChangedFile & { untracked?: boolean })[]>('stash.files', { index }),
  conflict: (path: string) => call<ConflictVersions>('conflict.versions', { path }),

  // operations
  stage: (paths: string[]) => call<Op>('stage', { paths }),
  stageAll: () => call<Op>('stage.all'),
  unstage: (paths: string[]) => call<Op>('unstage', { paths }),
  unstageAll: () => call<Op>('unstage.all'),
  applyPatch: (patch: string, opts: { cached: boolean; reverse: boolean }) => call<Op>('apply.patch', { patch, ...opts }),
  discardUnstaged: (paths: string[]) => call<Op>('discard.unstaged', { paths }),
  rollback: (paths: string[], deleteAdded = false) => call<Op>('rollback', { paths, deleteAdded }),
  deleteUntracked: (paths: string[]) => call<Op>('untracked.delete', { paths }),
  ignore: (paths: string[]) => call<Op>('ignore.add', { paths }),
  commitChanges: (o: { message: string; amend?: boolean; only?: boolean; signoff?: boolean; noVerify?: boolean; all?: boolean }) =>
    call<Op>('commit', o),
  checkout: (name: string, o: { remote?: boolean; smart?: boolean; detach?: boolean; localName?: string } = {}) =>
    call<Op>('branch.checkout', { name, ...o }),
  createBranch: (name: string, start: string | undefined, checkout: boolean, force = false) =>
    call<Op>('branch.create', { name, start, checkout, force }),
  renameBranch: (oldName: string, newName: string) => call<Op>('branch.rename', { oldName, newName }),
  deleteBranch: (name: string, force = false) => call<Op>('branch.delete', { name, force }),
  deleteRemoteBranch: (name: string) => call<Op>('branch.deleteRemote', { name }),
  setUpstream: (branch: string, upstream: string | null) => call<Op>('branch.setUpstream', { branch, upstream }),
  merge: (ref: string, o: { noFF?: boolean; squash?: boolean; ffOnly?: boolean; noCommit?: boolean } = {}) =>
    call<Op>('merge', { ref, ...o }),
  rebase: (onto: string, branch?: string) => call<Op>('rebase', { onto, branch }),
  sequence: (action: 'continue' | 'abort' | 'skip') => call<Op>('sequence.control', { action }),
  cherryPick: (hashes: string[]) => call<Op>('cherry-pick', { hashes }),
  revert: (hashes: string[]) => call<Op>('revert', { hashes }),
  reset: (hash: string, mode: string) => call<Op>('reset', { hash, mode }),
  checkoutRevision: (hash: string) => call<Op>('checkout.revision', { hash }),
  undoCommit: () => call<Op>('commit.undo'),
  createTag: (name: string, hash: string, message?: string) => call<Op>('tag.create', { name, hash, message }),
  deleteTag: (name: string) => call<Op>('tag.delete', { name }),
  pushTag: (remote: string, name: string) => call<Op>('tag.push', { remote, name }),
  deleteRemoteTag: (remote: string, name: string) => call<Op>('tag.deleteRemote', { remote, name }),
  fetch: (remote?: string) => call<Op>('fetch', { remote }),
  pull: (mode: 'merge' | 'rebase' | 'ff-only', remote?: string, branch?: string) => call<Op>('pull', { mode, remote, branch }),
  push: (o: {
    remote: string;
    branch: string;
    remoteBranch: string;
    force?: 'lease' | 'force' | false;
    setUpstream?: boolean;
    tags?: boolean;
    noVerify?: boolean;
  }) => call<Op>('push', o),
  addRemote: (name: string, url: string) => call<Op>('remote.add', { name, url }),
  removeRemote: (name: string) => call<Op>('remote.remove', { name }),
  setRemoteUrl: (name: string, url: string) => call<Op>('remote.setUrl', { name, url }),
  stashSave: (o: { message?: string; includeUntracked?: boolean; keepIndex?: boolean; paths?: string[] }) =>
    call<Op>('stash.save', o),
  stashApply: (index: number, pop: boolean, reinstateIndex = false) => call<Op>('stash.apply', { index, pop, reinstateIndex }),
  stashDrop: (index: number) => call<Op>('stash.drop', { index }),
  stashClear: () => call<Op>('stash.clear'),
  stashBranch: (index: number, name: string) => call<Op>('stash.branch', { index, name }),
  acceptConflict: (paths: string[], side: 'ours' | 'theirs') => call<Op>('conflict.accept', { paths, side }),
  resolveConflict: (path: string, content: string) => call<Op>('conflict.resolve', { path, content }),
  markResolved: (paths: string[]) => call<Op>('conflict.markResolved', { paths }),
};
