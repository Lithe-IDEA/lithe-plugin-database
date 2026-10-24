import { useEffect, useRef } from 'preact/hooks';
import { update, useStore } from '../store.ts';

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

interface OpenMenu {
  x: number;
  y: number;
  entries: MenuEntry[];
}

let menu: OpenMenu | null = null;

/** Opens a menu at the pointer of `event`. */
export function showMenu(event: MouseEvent, entries: MenuEntry[]): void {
  event.preventDefault();
  event.stopPropagation();
  menu = { x: event.clientX, y: event.clientY, entries };
  update({});
}

/** Opens a menu below `element`, for toolbar buttons. */
export function showMenuBelow(element: HTMLElement, entries: MenuEntry[]): void {
  const bounds = element.getBoundingClientRect();
  menu = { x: bounds.left, y: bounds.bottom + 2, entries };
  update({});
}

function hideMenu(): void {
  menu = null;
  update({});
}

export function MenuHost() {
  useStore(() => menu);
  if (!menu) return null;
  return <MenuPanel {...menu} onClose={hideMenu} />;
}

function MenuPanel(props: OpenMenu & { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = panel.current;
    if (element) {
      // Kept inside the window.
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(4, Math.min(props.x, window.innerWidth - bounds.width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(props.y, window.innerHeight - bounds.height - 4))}px`;
    }
    const close = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) props.onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && props.onClose();
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', props.onClose);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', props.onClose);
    };
  }, [props.x, props.y]);
  return (
    <div ref={panel} class="menu" role="menu" style={{ left: `${props.x}px`, top: `${props.y}px` }}>
      <Entries entries={props.entries} onClose={props.onClose} />
    </div>
  );
}

function Entries({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  return (
    <>
      {entries.map((entry, index) =>
        entry === 'separator' ? (
          <div key={index} class="menu-separator" role="separator" />
        ) : entry.submenu ? (
          <div key={index} class={`menu-item has-submenu ${entry.disabled ? 'disabled' : ''}`} role="menuitem" aria-haspopup="true">
            <span>{entry.label}</span>
            <span class="menu-arrow">›</span>
            {!entry.disabled && (
              <div class="menu submenu" role="menu">
                <Entries entries={entry.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ) : (
          <button
            key={index}
            class={`menu-item ${entry.destructive ? 'destructive' : ''}`}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.action?.();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </>
  );
}
