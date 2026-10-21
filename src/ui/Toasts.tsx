import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { createStore, useStore } from '../store';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  type: 'info' | 'success' | 'warn' | 'error';
  title: string;
  message?: ReactNode;
  actions?: ToastAction[];
}

const toastStore = createStore<{ list: ToastEntry[] }>({ list: [] });
let nextId = 1;

export function dismissToast(id: number) {
  toastStore.set((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

export function toast(t: Omit<ToastEntry, 'id'> & { timeout?: number }) {
  const id = nextId++;
  toastStore.set((s) => ({ list: [...s.list.slice(-4), { ...t, id }] }));
  const timeout = t.timeout ?? (t.type === 'error' ? 12000 : t.actions?.length ? 10000 : 4000);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

const ICONS = {
  info: <Info size={16} className="c-info" />,
  success: <CircleCheck size={16} className="c-success" />,
  warn: <TriangleAlert size={16} className="c-warn" />,
  error: <CircleAlert size={16} className="c-error" />,
};

export function ToastHost() {
  const list = useStore(toastStore, (s) => s.list);
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <div className="toast-icon">{ICONS[t.type]}</div>
          <div className="toast-content">
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-msg">{t.message}</div>}
            {t.actions && (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    className="link-btn"
                    onClick={() => {
                      dismissToast(t.id);
                      a.onClick();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn toast-close" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
