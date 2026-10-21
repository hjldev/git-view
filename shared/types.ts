// Types shared between the server (git API) and the web client.

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting';

export interface RepoInfo {
  root: string;
  name: string;
  gitDir: string;
  head: string | null; // current branch name, null when detached
  headHash: string | null; // null on an unborn branch
  detached: boolean;
  state: RepoState;
  upstream: string | null;
  ahead: number;
  behind: number;
  remotes: Remote[];
  userName: string;
  userEmail: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export type RefType = 'head' | 'local' | 'remote' | 'tag' | 'stash';

export interface RefLabel {
  type: RefType;
  name: string; // short name, e.g. "main", "origin/main", "v1.0"
}

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number; // unix seconds
  committerName: string;
  committerDate: number;
  subject: string;
  refs: RefLabel[];
}

export interface LogQuery {
  max?: number;
  skip?: number;
  branches?: string[]; // empty / undefined => --all
  author?: string;
  grep?: string;
  path?: string;
  since?: string;
  until?: string;
  range?: string; // e.g. "main..feature"
}

export interface LogResult {
  commits: Commit[];
  hasMore: boolean;
  /** true when parent links are not meaningful for drawing (grep/author filters). */
  flat: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  /** Porcelain XY code for unmerged entries: UU, AA, DU, UD, AU, UA, DD. */
  conflict?: string;
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  committerDate: number;
  subject: string;
  body: string;
  refs: RefLabel[];
  files: ChangedFile[];
  /** Branches (local + remote) that contain this commit. */
  containedIn?: string[];
}

export interface WorkingStatus {
  branch: string | null;
  headHash: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  conflicted: ChangedFile[];
  state: RepoState;
}

export interface Branch {
  name: string; // short name
  fullName: string; // refs/heads/x or refs/remotes/origin/x
  hash: string;
  isRemote: boolean;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  subject: string;
  date: number;
}

export interface Tag {
  name: string;
  hash: string; // the commit it points to
  annotated: boolean;
  subject: string;
  date: number;
}

export interface RefsResult {
  head: string | null;
  headHash: string | null;
  local: Branch[];
  remote: Branch[];
  tags: Tag[];
}

export interface StashEntry {
  index: number;
  ref: string; // stash@{n}
  hash: string;
  message: string;
  branch: string;
  date: number;
}

export type DiffLineType = 'ctx' | 'add' | 'del' | 'meta';

export interface DiffLine {
  t: DiffLineType;
  s: string; // text without the +/-/space prefix
  o?: number; // old line number
  n?: number; // new line number
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  truncated?: boolean;
}

export type DiffSpec =
  | { kind: 'commit'; hash: string; parent?: string; path?: string; oldPath?: string }
  | { kind: 'unstaged'; path: string }
  | { kind: 'staged'; path: string; oldPath?: string }
  | { kind: 'untracked'; path: string }
  | { kind: 'stash'; index: number; path?: string; oldPath?: string; untracked?: boolean }
  | { kind: 'refs'; from: string; to: string; path?: string; oldPath?: string }
  | { kind: 'worktree-vs-ref'; ref: string; path?: string };

export interface BlameLine {
  hash: string;
  origLine: number;
  line: number;
  content: string;
}

export interface BlameCommit {
  hash: string;
  author: string;
  authorEmail: string;
  authorTime: number;
  summary: string;
  previous?: string;
  filename: string;
}

export interface BlameResult {
  path: string;
  rev: string | null;
  lines: BlameLine[];
  commits: Record<string, BlameCommit>;
}

export interface ConflictVersions {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string | null;
  oursLabel: string;
  theirsLabel: string;
}

export interface OpResult {
  ok: boolean;
  output: string;
  /** Set when the operation left the repository with conflicts to resolve. */
  conflicts?: boolean;
}

export interface Author {
  name: string;
  email: string;
  count: number;
}

export interface RecentRepo {
  path: string;
  name: string;
  openedAt: number;
}

export interface FsEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}
