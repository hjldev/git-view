import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Cloud, Folder, GitBranch, Laptop, Search, Tag as TagIcon, X } from 'lucide-react';
import type { Branch, Tag } from '../../shared/types';
import { revealCommit, showInLog } from '../actions';
import { localBranchMenu, remoteBranchMenu, tagMenu } from '../menus';
import { useApp, usePref } from '../store';
import { showMenu } from '../ui/ContextMenu';
import { cx } from '../util';

type Leaf = { kind: 'local' | 'remote'; branch: Branch } | { kind: 'tag'; tag: Tag };

interface Node {
  key: string;
  label: string;
  icon?: ReactNode;
  children?: Node[];
  leaf?: Leaf;
}

function groupByFolder(prefix: string, items: { name: string; leaf: Leaf }[], strip = ''): Node[] {
  const folders = new Map<string, { name: string; leaf: Leaf }[]>();
  const leaves: Node[] = [];
  for (const it of items) {
    const rest = it.name.slice(strip.length);
    const slash = rest.indexOf('/');
    if (slash > 0) {
      const f = rest.slice(0, slash);
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f)!.push(it);
    } else {
      leaves.push({ key: `${prefix}:${it.name}`, label: rest, leaf: it.leaf });
    }
  }
  const dirs: Node[] = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, list]) => ({
      key: `${prefix}/${strip}${f}`,
      label: f,
      icon: <Folder size={14} className="folder-icon" />,
      children: groupByFolder(prefix, list, `${strip}${f}/`),
    }));
  return [...dirs, ...leaves];
}

function filterTree(nodes: Node[], q: string): Node[] {
  if (!q) return nodes;
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.children) {
      const c = filterTree(n.children, q);
      if (c.length) out.push({ ...n, children: c });
    } else if (n.leaf) {
      const name = n.leaf.kind === 'tag' ? n.leaf.tag.name : n.leaf.branch.name;
      if (name.toLowerCase().includes(q)) out.push(n);
    }
  }
  return out;
}

export function BranchTree() {
  const refs = useApp((s) => s.refs);
  const info = useApp((s) => s.info);
  const filterBranches = useApp((s) => s.logFilter.branches);
  const [collapsed, setCollapsed] = usePref<string[]>('branchTree.collapsed', ['tags']);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const tree = useMemo(() => {
    if (!refs) return [];
    const favorites = new Set(['main', 'master']);
    const local = [...refs.local].sort(
      (a, b) => Number(favorites.has(b.name)) - Number(favorites.has(a.name)) || a.name.localeCompare(b.name),
    );
    const remotes = new Map<string, Branch[]>();
    for (const b of refs.remote) {
      const r = b.name.slice(0, b.name.indexOf('/'));
      if (!remotes.has(r)) remotes.set(r, []);
      remotes.get(r)!.push(b);
    }
    const nodes: Node[] = [];
    if (refs.head || info?.headHash) {
      nodes.push({
        key: 'head',
        label: refs.head ? `HEAD（当前分支）` : 'HEAD（游离）',
        leaf: refs.head
          ? { kind: 'local', branch: refs.local.find((b) => b.name === refs.head)! }
          : {
              kind: 'local',
              branch: {
                name: 'HEAD',
                fullName: 'HEAD',
                hash: info?.headHash ?? '',
                isRemote: false,
                isHead: true,
                upstream: null,
                ahead: 0,
                behind: 0,
                upstreamGone: false,
                subject: '',
                date: 0,
              },
            },
      });
    }
    nodes.push({
      key: 'local',
      label: '本地',
      icon: <Laptop size={14} />,
      children: groupByFolder('local', local.map((b) => ({ name: b.name, leaf: { kind: 'local' as const, branch: b } }))),
    });
    if (remotes.size) {
      nodes.push({
        key: 'remote',
        label: '远程',
        icon: <Cloud size={14} />,
        children: [...remotes.entries()].map(([r, list]) => ({
          key: `remote:${r}`,
          label: r,
          icon: <Cloud size={14} className="muted" />,
          children: groupByFolder(
            `remote:${r}`,
            list.map((b) => ({ name: b.name, leaf: { kind: 'remote' as const, branch: b } })),
            `${r}/`,
          ),
        })),
      });
    }
    if (refs.tags.length) {
      nodes.push({
        key: 'tags',
        label: `标签`,
        icon: <TagIcon size={14} />,
        children: refs.tags.map((t) => ({ key: `tag:${t.name}`, label: t.name, leaf: { kind: 'tag' as const, tag: t } })),
      });
    }
    return nodes;
  }, [refs, info?.headHash]);

  const q = query.trim().toLowerCase();
  const visible = filterTree(tree, q);
  const collapsedSet = new Set(collapsed);

  const toggle = (key: string) => {
    const next = new Set(collapsedSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed([...next]);
  };

  const leafName = (l: Leaf) => (l.kind === 'tag' ? l.tag.name : l.branch.name);
  const leafHash = (l: Leaf) => (l.kind === 'tag' ? l.tag.hash : l.branch.hash);

  const rows: ReactNode[] = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const n of nodes) {
      if (n.children) {
        const isCol = !q && collapsedSet.has(n.key);
        rows.push(
          <div key={n.key} className="tree-row" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(n.key)}>
            <span className="tree-toggle">{isCol ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
            {n.icon}
            <span className="ellipsis">{n.label}</span>
          </div>,
        );
        if (!isCol) walk(n.children, depth + 1);
        continue;
      }
      const leaf = n.leaf!;
      if (leaf.kind !== 'tag' && !leaf.branch) continue;
      const name = leafName(leaf);
      const isCurrent = leaf.kind === 'local' && leaf.branch.isHead;
      const filtered = filterBranches.length === 1 && filterBranches[0] === name;
      rows.push(
        <div
          key={n.key}
          className={cx('tree-row', selected === n.key && 'selected', filtered && 'filtered')}
          style={{ paddingLeft: 4 + depth * 14 + 16 }}
          title={leaf.kind === 'tag' ? `${name}\n${leaf.tag.subject}` : `${name}\n${leaf.branch.subject}${leaf.branch.upstream ? `\n跟踪 ${leaf.branch.upstream}` : ''}`}
          onClick={() => {
            setSelected(n.key);
            const h = leafHash(leaf);
            if (h) revealCommit(h);
          }}
          onDoubleClick={() => {
            if (name !== 'HEAD') showInLog({ branches: filtered ? [] : [name] });
          }}
          onContextMenu={(e) => {
            setSelected(n.key);
            if (name === 'HEAD') return e.preventDefault();
            showMenu(e, leaf.kind === 'tag' ? tagMenu(name) : leaf.kind === 'remote' ? remoteBranchMenu(name) : localBranchMenu(name));
          }}
        >
          {leaf.kind === 'tag' ? (
            <TagIcon size={13} className="muted" />
          ) : (
            <GitBranch size={13} className={cx(isCurrent ? 'c-accent' : 'muted')} />
          )}
          <span className={cx('ellipsis', isCurrent && 'bold')}>{n.key === 'head' ? n.label : n.label}</span>
          {n.key === 'head' && refs?.head && <span className="muted small ellipsis">{refs.head}</span>}
          {leaf.kind === 'local' && (leaf.branch.ahead > 0 || leaf.branch.behind > 0) && (
            <span className="track small" title={`领先 ${leaf.branch.ahead}，落后 ${leaf.branch.behind}`}>
              {leaf.branch.ahead > 0 && <span className="c-add">↑{leaf.branch.ahead}</span>}
              {leaf.branch.behind > 0 && <span className="c-accent">↓{leaf.branch.behind}</span>}
            </span>
          )}
          {leaf.kind === 'local' && leaf.branch.upstreamGone && (
            <span className="small c-warn" title="上游分支已在远程删除">
              gone
            </span>
          )}
        </div>,
      );
    }
  };
  walk(visible, 0);

  return (
    <div className="panel branch-tree">
      <div className="panel-toolbar">
        <div className="search-box">
          <Search size={13} className="muted" />
          <input placeholder="搜索分支" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="panel-body tree">{rows}</div>
    </div>
  );
}
