import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { createStore, useStore } from '../store';
import { cx } from '../util';

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      danger?: boolean;
      hint?: string;
      checked?: boolean;
      submenu?: MenuEntry[];
    }
  | { header: string };

export type MenuEntry = MenuItem | 'sep' | false | null | undefined | '' | 0;

interface MenuState {
  open: { x: number; y: number; items: MenuEntry[] } | null;
}

const menuStore = createStore<MenuState>({ open: null });

export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) {
  e.preventDefault?.();
  menuStore.set({ open: { x: e.clientX, y: e.clientY, items } });
}

export function showMenuAt(el: HTMLElement, items: MenuEntry[]) {
  const r = el.getBoundingClientRect();
  menuStore.set({ open: { x: r.left, y: r.bottom + 2, items } });
}

export function closeMenu() {
  menuStore.set({ open: null });
}

function clean(items: MenuEntry[]): (MenuItem | 'sep')[] {
  const out: (MenuItem | 'sep')[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep' && (out.length === 0 || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

function MenuList({ items, x, y, depth, flipRight }: { items: MenuEntry[]; x: number; y: number; depth: number; flipRight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flip: number } | null>(null);
  const list = clean(items);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = flipRight !== undefined ? flipRight - r.width : window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y, flipRight]);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {list.map((it, i) => {
        if (it === 'sep') return <div key={i} className="ctx-sep" />;
        if ('header' in it)
          return (
            <div key={i} className="ctx-header">
              {it.header}
            </div>
          );
        const hasSub = !!it.submenu?.length;
        return (
          <div
            key={i}
            className={cx('ctx-item', it.disabled && 'disabled', it.danger && 'danger', sub?.index === i && 'open')}
            onMouseEnter={(e) => {
              if (hasSub) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSub({ index: i, x: r.right - 2, y: r.top - 4, flip: r.left + 2 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.disabled || hasSub) return;
              closeMenu();
              it.onClick?.();
            }}
          >
            <span className="ctx-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
            {hasSub && <ChevronRight size={14} className="ctx-arrow" />}
          </div>
        );
      })}
      {sub && (list[sub.index] as MenuItem & { submenu?: MenuEntry[] }).submenu && (
        <MenuList
          items={(list[sub.index] as { submenu: MenuEntry[] }).submenu}
          x={sub.x}
          y={sub.y}
          flipRight={sub.flip}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

export function ContextMenuHost() {
  const open = useStore(menuStore, (s) => s.open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ctx-menu')) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [open]);
  if (!open) return null;
  return <MenuList key={`${open.x},${open.y}`} items={open.items} x={open.x} y={open.y} depth={0} />;
}
