import { toChildArray, type ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

/**
 * Two panes with a draggable divider. Dragging changes one CSS variable per
 * animation frame and commits the width when the pointer is released, so a
 * drag never re-renders the panes.
 */
export function Splitter(props: {
  storageKey: string;
  initial: number;
  minimum: number;
  maximum: number;
  vertical?: boolean;
  children: ComponentChildren;
}) {
  const [size, setSize] = useState(props.initial);
  const container = useRef<HTMLDivElement>(null);
  const [first, second] = toChildArray(props.children);
  const property = '--split-size';

  const onPointerDown = (event: PointerEvent) => {
    const element = container.current;
    if (!element) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const bounds = element.getBoundingClientRect();
    let next = size;
    let frame = 0;
    const move = (moved: PointerEvent) => {
      const offset = props.vertical ? moved.clientY - bounds.top : moved.clientX - bounds.left;
      next = Math.round(Math.min(props.maximum, Math.max(props.minimum, offset)));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          element.style.setProperty(property, `${next}px`);
        });
      }
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (frame) cancelAnimationFrame(frame);
      element.style.setProperty(property, `${next}px`);
      setSize(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  return (
    <div ref={container} class={`split ${props.vertical ? 'vertical' : 'horizontal'}`} style={{ [property]: `${size}px` }}>
      <div class="split-first">{first}</div>
      <div class="split-handle" role="separator" aria-orientation={props.vertical ? 'horizontal' : 'vertical'} onPointerDown={onPointerDown} />
      <div class="split-second">{second}</div>
    </div>
  );
}
