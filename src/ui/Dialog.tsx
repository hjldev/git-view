import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createStore, useStore } from '../store';
import { cx } from '../util';

interface DialogEntry {
  id: number;
  node: ReactNode;
}

const dialogStore = createStore<{ list: DialogEntry[] }>({ list: [] });
let nextId = 1;

/**
 * Opens a dialog. `render` receives a `done` callback which closes the dialog
 * and resolves the returned promise with the given value.
 */
export function openDialog<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = nextId++;
    const done = (v: T) => {
      dialogStore.set((s) => ({ list: s.list.filter((d) => d.id !== id) }));
      resolve(v);
    };
    dialogStore.set((s) => ({ list: [...s.list, { id, node: render(done) }] }));
  });
}

export function DialogHost() {
  const list = useStore(dialogStore, (s) => s.list);
  return (
    <>
      {list.map((d) => (
        <div key={d.id}>{d.node}</div>
      ))}
    </>
  );
}

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
  /** Called on Ctrl/Cmd+Enter or Enter in a single-line input. */
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input:not([type=checkbox]):not([type=radio]), textarea, select');
    (first ?? el)?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={cx('modal', props.className)}
        style={{ width: props.width ?? 460 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            props.onClose();
          } else if (e.key === 'Enter' && props.onSubmit) {
            const t = e.target as HTMLElement;
            if ((e.metaKey || e.ctrlKey) || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox')) {
              e.preventDefault();
              props.onSubmit();
            }
          }
        }}
      >
        <div className="modal-title">
          <span>{props.title}</span>
          <button className="icon-btn" onClick={props.onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-footer">{props.footer}</div>}
      </div>
    </div>
  );
}

export function confirmDialog(o: {
  title: string;
  message: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  extra?: { label: string; value: string };
}): Promise<boolean | string> {
  return openDialog<boolean | string>((done) => (
    <Modal
      title={o.title}
      onClose={() => done(false)}
      onSubmit={() => done(true)}
      footer={
        <>
          {o.extra && (
            <button className="btn" onClick={() => done(o.extra!.value)}>
              {o.extra.label}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => done(false)}>
            {o.cancelText ?? '取消'}
          </button>
          <button className={cx('btn', o.danger ? 'danger' : 'primary')} data-autofocus onClick={() => done(true)}>
            {o.okText ?? '确定'}
          </button>
        </>
      }
    >
      <div className="confirm-msg">{o.message}</div>
    </Modal>
  ));
}

function PromptBody(props: {
  label?: string;
  initial: string;
  placeholder?: string;
  validate?: (v: string) => string | null;
  multiline?: boolean;
  onChange: (v: string, err: string | null) => void;
}) {
  const [v, setV] = useState(props.initial);
  const err = props.validate?.(v) ?? null;
  useEffect(() => props.onChange(v, err), [v, err]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="form">
      {props.label && <label className="form-label">{props.label}</label>}
      {props.multiline ? (
        <textarea className="input" rows={5} value={v} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} />
      ) : (
        <input className="input" value={v} placeholder={props.placeholder} onChange={(e) => setV(e.target.value)} />
      )}
      {err && v && <div className="form-error">{err}</div>}
    </div>
  );
}

export function promptDialog(o: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okText?: string;
  multiline?: boolean;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  let value = o.initial ?? '';
  let error: string | null = null;
  return openDialog<string | null>((done) => {
    const submit = () => {
      if (!error && value.trim()) done(value);
    };
    return (
      <Modal
        title={o.title}
        onClose={() => done(null)}
        onSubmit={submit}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => done(null)}>
              取消
            </button>
            <button className="btn primary" onClick={submit}>
              {o.okText ?? '确定'}
            </button>
          </>
        }
      >
        <PromptBody
          label={o.label}
          initial={value}
          placeholder={o.placeholder}
          validate={o.validate}
          multiline={o.multiline}
          onChange={(v, e) => {
            value = v;
            error = e;
          }}
        />
      </Modal>
    );
  });
}

export function messageDialog(title: string, message: ReactNode, pre?: string) {
  return openDialog<void>((done) => (
    <Modal
      title={title}
      onClose={() => done()}
      width={620}
      footer={
        <>
          <span className="spacer" />
          <button className="btn primary" data-autofocus onClick={() => done()}>
            关闭
          </button>
        </>
      }
    >
      <div className="confirm-msg">{message}</div>
      {pre && <pre className="output-pre">{pre}</pre>}
    </Modal>
  ));
}
