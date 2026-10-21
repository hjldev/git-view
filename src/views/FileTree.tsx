import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, File, FileCode, FileImage, FileText, Folder } from 'lucide-react';
import type { FileStatus } from '../../shared/types';
import { basename, cx, dirname, statusClass, STATUS_LABEL } from '../util';

export interface TreeItem {
  key: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions?: number;
  deletions?: number;
}

type Row<T> = { type: 'dir'; key: string; name: string; depth: number; count: number } | { type: 'file'; item: T; depth: number };

interface DirNode<T> {
  name: string;
  path: string;
  dirs: Map<string, DirNode<T>>;
  files: T[];
}

function count<T>(d: DirNode<T>): number {
  let n = d.files.length;
  for (const c of d.dirs.values()) n += count(c);
  return n;
}

export function buildRows<T extends TreeItem>(items: T[], grouped: boolean, collapsed: Set<string>, prefix = ''): Row<T>[] {
  if (!grouped) {
    return [...items].sort((a, b) => basename(a.path).localeCompare(basename(b.path))).map((item) => ({ type: 'file' as const, item, depth: 0 }));
  }
  const root: DirNode<T> = { name: '', path: '', dirs: new Map(), files: [] };
  for (const item of items) {
    const parts = item.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: node.path ? `${node.path}/${parts[i]}` : parts[i], dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(item);
  }
  const rows: Row<T>[] = [];
  const walk = (node: DirNode<T>, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let d of dirs) {
      let name = d.name;
      // Compact chains of single-child directories: src/main/java
      while (d.files.length === 0 && d.dirs.size === 1) {
        d = [...d.dirs.values()][0];
        name += '/' + d.name;
      }
      const key = `${prefix}dir:${d.path}`;
      rows.push({ type: 'dir', key, name, depth, count: count(d) });
      if (!collapsed.has(key)) walk(d, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) rows.push({ type: 'file', item: f, depth });
  };
  walk(root, 0);
  return rows;
}

/** Items in the order the tree displays them (for next/previous file navigation). */
export function displayOrder<T extends TreeItem>(items: T[], grouped: boolean): T[] {
  return buildRows(items, grouped, new Set()).flatMap((r) => (r.type === 'file' ? [r.item] : []));
}

const IMG = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i;
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|java|kt|go|rs|py|rb|php|c|h|cc|cpp|hpp|cs|swift|m|scala|vue|svelte|css|scss|less|html|xml|json|ya?ml|toml|sh|sql|gradle|lua)$/i;
const TEXT = /\.(md|txt|rst|adoc|log|csv)$/i;

export function FileIcon({ path }: { path: string }) {
  if (IMG.test(path)) return <FileImage size={14} className="file-icon" />;
  if (CODE.test(path)) return <FileCode size={14} className="file-icon" />;
  if (TEXT.test(path)) return <FileText size={14} className="file-icon" />;
  return <File size={14} className="file-icon" />;
}

export function FileTree<T extends TreeItem>(props: {
  items: T[];
  grouped: boolean;
  selected: Set<string>;
  keyPrefix?: string;
  baseDepth?: number;
  onSelect: (item: T, e: React.MouseEvent) => void;
  onOpen?: (item: T) => void;
  onContextMenu?: (item: T, e: React.MouseEvent) => void;
  renderActions?: (item: T) => ReactNode;
  showStats?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () => buildRows(props.items, props.grouped, collapsed, props.keyPrefix),
    [props.items, props.grouped, collapsed, props.keyPrefix],
  );
  const base = props.baseDepth ?? 0;
  return (
    <>
      {rows.map((r) => {
        if (r.type === 'dir') {
          const isCollapsed = collapsed.has(r.key);
          return (
            <div
              key={r.key}
              className="tree-row"
              style={{ paddingLeft: 6 + (base + r.depth) * 16 }}
              onClick={() => {
                const next = new Set(collapsed);
                if (isCollapsed) next.delete(r.key);
                else next.add(r.key);
                setCollapsed(next);
              }}
            >
              <span className="tree-toggle">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
              <Folder size={14} className="folder-icon" />
              <span className="ellipsis">{r.name}</span>
              <span className="tree-count">{r.count}</span>
            </div>
          );
        }
        const it = r.item;
        const dir = dirname(it.path);
        return (
          <div
            key={it.key}
            className={cx('tree-row', props.selected.has(it.key) && 'selected')}
            style={{ paddingLeft: 6 + (base + r.depth) * 16 + 16 }}
            title={`${it.oldPath ? `${it.oldPath} → ` : ''}${it.path}\n${STATUS_LABEL[it.status] ?? ''}`}
            onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
            onClick={(e) => props.onSelect(it, e)}
            onDoubleClick={() => props.onOpen?.(it)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!props.selected.has(it.key)) props.onSelect(it, e);
              props.onContextMenu?.(it, e);
            }}
          >
            <FileIcon path={it.path} />
            <span className={cx('ellipsis file-name', statusClass(it.status))}>{basename(it.path)}</span>
            {!props.grouped && dir && <span className="ellipsis muted small dir-hint">{dir}</span>}
            {it.oldPath && it.status === 'R' && <span className="muted small nowrap">← {basename(it.oldPath)}</span>}
            <span className="spacer" />
            {props.showStats && (it.additions || it.deletions) ? (
              <span className="stats">
                {!!it.additions && <span className="c-add">+{it.additions}</span>}
                {!!it.deletions && <span className="c-del">−{it.deletions}</span>}
              </span>
            ) : null}
            {props.renderActions && <span className="row-actions">{props.renderActions(it)}</span>}
          </div>
        );
      })}
    </>
  );
}
