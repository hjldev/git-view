import { spawn } from 'node:child_process';

export class GitError extends Error {
  stderr: string;
  stdout: string;
  code: number | null;
  args: string[];

  constructor(args: string[], code: number | null, stdout: string, stderr: string) {
    const detail = (stderr || stdout).trim();
    super(detail || `git ${args[0]} 失败 (exit ${code})`);
    this.args = args;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  cwd: string;
  input?: string;
  /** Exit codes (besides 0) that should not be treated as failures. */
  okCodes?: number[];
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
}

export interface GitOutput {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

const BASE_ENV: Record<string, string> = {
  // Never block waiting for a password on a terminal we don't have.
  GIT_TERMINAL_PROMPT: '0',
  // Commands such as `git status` must not rewrite the index: the file
  // watcher would see that write and trigger yet another refresh.
  GIT_OPTIONAL_LOCKS: '0',
  // merge/revert/cherry-pick --continue keep their prepared message.
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',
};

const GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export function runGit(args: string[], opts: GitOptions): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GLOBAL_ARGS, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...BASE_ENV, ...opts.env },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (outBytes + chunk.length > maxBytes) {
        out.push(chunk.subarray(0, maxBytes - outBytes));
        truncated = true;
        child.kill();
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (truncated) return resolve({ stdout, stderr, code: 0, truncated });
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve({ stdout, stderr, code: code ?? 0, truncated });
      } else {
        reject(new GitError(args, code, stdout, stderr));
      }
    });
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new GitError(args, null, '', `git ${args[0]} 超时 (${Math.round(opts.timeoutMs! / 1000)}s)`));
      }, opts.timeoutMs);
    }
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input);
    }
  });
}

export async function git(cwd: string, args: string[], extra: Omit<GitOptions, 'cwd'> = {}): Promise<string> {
  return (await runGit(args, { cwd, ...extra })).stdout;
}

/** Runs a mutating command and returns combined stdout+stderr for display. */
export async function gitOp(cwd: string, args: string[], extra: Omit<GitOptions, 'cwd'> = {}): Promise<string> {
  const r = await runGit(args, { cwd, ...extra });
  return [r.stdout, r.stderr].filter((s) => s.trim()).join('\n').trim();
}

// Serialize state-changing operations per repository so concurrent clicks
// cannot race each other on index.lock.
const locks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(root, next);
  next.finally(() => {
    if (locks.get(root) === next) locks.delete(root);
  }).catch(() => undefined);
  return next;
}
