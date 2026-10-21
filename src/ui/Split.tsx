import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePref } from '../store';
import { cx } from '../util';

/**
 * Two-pane resizable split. The size of the `fixed` pane (first or second) is
 * persisted under `id`; the other pane takes the remaining space.
 */
export function Split(props: {
  id: string;
  dir: 'h' | 'v';
  initial: number;
  min?: number;
  max?: number;
  /** Minimum space kept for the flexible pane; the fixed pane shrinks first. */
  minRest?: number;
  fixed?: 'first' | 'second';
  first: ReactNode;
  second: ReactNode;
  hideFirst?: boolean;
  hideSecond?: boolean;
  className?: string;
}) {
  const [size, setSize] = usePref<number>(`split.${props.id}`, props.initial);
  const ref = useRef<HTMLDivElement>(null);
  const fixed = props.fixed ?? 'first';
  const horizontal = props.dir === 'h';
  const [total, setTotal] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setTotal(horizontal ? el.clientWidth : el.clientHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [horizontal]);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const move = (ev: MouseEvent) => {
      const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
      let s = fixed === 'first' ? pos : total - pos;
      s = Math.max(props.min ?? 120, Math.min(s, props.max ?? total - (props.minRest ?? 120)));
      setSize(Math.round(s));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing', 'resizing-h', 'resizing-v');
    };
    document.body.classList.add('resizing', horizontal ? 'resizing-h' : 'resizing-v');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const showBoth = !props.hideFirst && !props.hideSecond;
  const min = props.min ?? 120;
  const effective = total > 0 ? Math.max(min, Math.min(size, total - (props.minRest ?? 200))) : size;
  const fixedStyle = horizontal ? { width: effective, flex: 'none' } : { height: effective, flex: 'none' };

  return (
    <div ref={ref} className={cx('split', horizontal ? 'split-h' : 'split-v', props.className)}>
      {!props.hideFirst && (
        <div className="split-pane" style={showBoth && fixed === 'first' ? fixedStyle : undefined}>
          {props.first}
        </div>
      )}
      {showBoth && <div className="split-handle" onMouseDown={onDown} />}
      {!props.hideSecond && (
        <div className="split-pane" style={showBoth && fixed === 'second' ? fixedStyle : undefined}>
          {props.second}
        </div>
      )}
    </div>
  );
}
