import { Tag } from 'lucide-react';
import type { RefLabel } from '../../shared/types';
import { localBranchMenu, remoteBranchMenu, tagMenu } from '../menus';
import { showMenu } from '../ui/ContextMenu';
import { cx } from '../util';

interface Badge {
  kind: 'head' | 'local' | 'remote' | 'tag' | 'detached';
  label: string;
  title: string;
  ref: string;
  remoteOnly?: boolean;
}

/** Merges "main" + "origin/main" into one "origin & main" badge like IDEA. */
export function toBadges(refs: RefLabel[], headBranch: string | null): Badge[] {
  const isHead = refs.some((r) => r.type === 'head');
  const locals = refs.filter((r) => r.type === 'local');
  const remotes = refs.filter((r) => r.type === 'remote');
  const used = new Set<string>();
  const badges: Badge[] = [];
  if (isHead && !headBranch) badges.push({ kind: 'detached', label: 'HEAD', title: '游离 HEAD', ref: 'HEAD' });
  for (const l of locals) {
    const matching = remotes.filter((r) => r.name.slice(r.name.indexOf('/') + 1) === l.name);
    matching.forEach((m) => used.add(m.name));
    const prefix = matching.map((m) => m.name.slice(0, m.name.indexOf('/'))).join(' & ');
    const current = isHead && l.name === headBranch;
    badges.push({
      kind: current ? 'head' : 'local',
      label: prefix ? `${prefix} & ${l.name}` : l.name,
      title: [current ? `当前分支 ${l.name}` : `本地分支 ${l.name}`, ...matching.map((m) => `远程分支 ${m.name}`)].join('\n'),
      ref: l.name,
    });
  }
  for (const r of remotes) {
    if (used.has(r.name)) continue;
    badges.push({ kind: 'remote', label: r.name, title: `远程分支 ${r.name}`, ref: r.name, remoteOnly: true });
  }
  for (const t of refs.filter((r) => r.type === 'tag')) {
    badges.push({ kind: 'tag', label: t.name, title: `标签 ${t.name}`, ref: t.name });
  }
  // Current branch first.
  badges.sort((a, b) => Number(b.kind === 'head') - Number(a.kind === 'head'));
  return badges;
}

export function RefBadges({ refs, headBranch, max = 3 }: { refs: RefLabel[]; headBranch: string | null; max?: number }) {
  if (!refs.length) return null;
  const badges = toBadges(refs, headBranch);
  const shown = badges.slice(0, max);
  const rest = badges.length - shown.length;
  return (
    <span className="ref-badges">
      {shown.map((b) => (
        <span
          key={b.kind + b.label}
          className={cx('ref-badge', `ref-${b.kind}`)}
          title={b.title}
          onContextMenu={(e) => {
            e.stopPropagation();
            if (b.kind === 'tag') showMenu(e, tagMenu(b.ref));
            else if (b.kind === 'remote') showMenu(e, remoteBranchMenu(b.ref));
            else if (b.kind !== 'detached') showMenu(e, localBranchMenu(b.ref));
          }}
        >
          {b.kind === 'tag' && <Tag size={10} />}
          {b.label}
        </span>
      ))}
      {rest > 0 && (
        <span className="ref-badge ref-more" title={badges.slice(max).map((b) => b.label).join('\n')}>
          +{rest}
        </span>
      )}
    </span>
  );
}
