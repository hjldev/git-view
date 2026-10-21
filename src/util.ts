import type { FileStatus } from '../shared/types';

const pad = (n: number) => String(n).padStart(2, '0');

/** IDEA-like relative dates: 今天 14:02 / 昨天 09:30 / 2026/9/1 10:00 */
export function formatDate(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) {
    const mins = Math.floor((now.getTime() - t) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    return `今天 ${time}`;
  }
  if (t >= startOfToday - 86400000) return `昨天 ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function formatFullDate(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const shortHash = (h: string) => h.slice(0, 8);

export function basename(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export const STATUS_LABEL: Record<FileStatus, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪',
  '!': '已忽略',
};

/** CSS class used to color a file name by its change type (IDEA style). */
export function statusClass(s: FileStatus | string): string {
  switch (s) {
    case 'A':
      return 'st-added';
    case 'D':
      return 'st-deleted';
    case 'R':
    case 'C':
      return 'st-renamed';
    case 'U':
      return 'st-conflict';
    case '?':
      return 'st-untracked';
    case '!':
      return 'st-ignored';
    default:
      return 'st-modified';
  }
}

/** Deterministic color for an author, used for avatars and blame. */
export function colorFor(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 50%)`;
}

export function initials(name: string): string {
  const n = name.trim();
  if (!n) return '?';
  if (/[一-龥]/.test(n)) return n.slice(-2);
  const parts = n.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(' ');
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
