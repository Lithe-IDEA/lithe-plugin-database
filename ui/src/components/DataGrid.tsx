import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Row } from '../api.ts';
import { t } from '../i18n.ts';
import { displayValue, editableText, parseTSV, toTSV } from '../values.ts';
import { copyToClipboard } from './clipboard.ts';
import { showMenu, type MenuEntry } from './Menu.tsx';

const ROW_HEIGHT = 24;
const OVERSCAN = 8;
const DEFAULT_WIDTH = 160;

export interface CellPosition {
  row: number;
  column: string;
}

export interface GridProps {
  columns: string[];
  rows: Row[];
  /** Column header tooltips, such as types. */
  columnDetails?: Record<string, string>;
  /** Extra class of a cell: modified, inserted, deleted, failed. */
  cellClass?: (row: number, column: string) => string | undefined;
  rowClass?: (row: number) => string | undefined;
  /** Makes cells editable; called with the text the user entered. */
  onEdit?: (row: number, column: string, text: string) => void;
  /** Extra entries of a cell's context menu. */
  cellMenu?: (position: CellPosition, selectedRows: number[]) => MenuEntry[];
  headerMenu?: (column: string) => MenuEntry[];
  /** Pasted tab-separated text, starting at a cell. */
  onPaste?: (position: CellPosition, cells: string[][]) => void;
  selectedRows?: number[];
  onSelectRows?: (rows: number[]) => void;
  /** Header label decoration, such as a sort arrow. */
  headerSuffix?: (column: string) => string;
  emptyText?: string;
}

/**
 * A spreadsheet-like grid that renders only the rows in view. Cells are
 * selected by click, ranges of rows by shift-click; Cmd-C copies the
 * selection as tab-separated text.
 */
export function DataGrid(props: GridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [active, setActive] = useState<CellPosition | null>(null);
  const [editing, setEditing] = useState<CellPosition | null>(null);
  const [internalSelection, setInternalSelection] = useState<number[]>([]);
  const selectedRows = props.selectedRows ?? internalSelection;
  const selectRows = props.onSelectRows ?? setInternalSelection;
  const anchor = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A new result starts at the top with nothing selected.
  useEffect(() => {
    setActive(null);
    setEditing(null);
    if (!props.selectedRows) setInternalSelection([]);
  }, [props.columns]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(props.rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const width = (column: string) => widths[column] ?? DEFAULT_WIDTH;
  const template = `48px ${props.columns.map(column => `${width(column)}px`).join(' ')}`;

  const selectionText = () => {
    const rows = selectedRows.length > 0 ? [...selectedRows].sort((a, b) => a - b) : active ? [active.row] : [];
    if (rows.length === 1 && active && selectedRows.length <= 1) return editableText(props.rows[active.row]?.[active.column]);
    return toTSV(props.columns, rows.map(index => props.rows[index]).filter(Boolean));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (editing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
      event.preventDefault();
      copyToClipboard(selectionText());
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      event.preventDefault();
      selectRows(props.rows.map((_, index) => index));
      return;
    }
    if (!active) return;
    const columnIndex = props.columns.indexOf(active.column);
    const move = (row: number, column: number) => {
      const next = { row: Math.max(0, Math.min(props.rows.length - 1, row)), column: props.columns[Math.max(0, Math.min(props.columns.length - 1, column))] };
      setActive(next);
      selectRows([next.row]);
      scrollIntoView(next.row);
      event.preventDefault();
    };
    if (event.key === 'ArrowDown') move(active.row + 1, columnIndex);
    else if (event.key === 'ArrowUp') move(active.row - 1, columnIndex);
    else if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) move(active.row, columnIndex + 1);
    else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) move(active.row, columnIndex - 1);
    else if ((event.key === 'Enter' || event.key === 'F2') && props.onEdit) {
      event.preventDefault();
      setEditing(active);
    }
  };

  const scrollIntoView = (row: number) => {
    const element = scroller.current;
    if (!element) return;
    const top = row * ROW_HEIGHT;
    const headerHeight = ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight - headerHeight) element.scrollTop = top + ROW_HEIGHT * 2 - element.clientHeight;
  };

  const onPaste = (event: ClipboardEvent) => {
    if (editing || !props.onPaste || !active) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    props.onPaste(active, parseTSV(text));
  };

  const clickCell = (event: MouseEvent, row: number, column: string) => {
    setActive({ row, column });
    if (event.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, row), Math.max(anchor.current, row)];
      selectRows(Array.from({ length: to - from + 1 }, (_, index) => from + index));
    } else if (event.metaKey || event.ctrlKey) {
      selectRows(selectedRows.includes(row) ? selectedRows.filter(item => item !== row) : [...selectedRows, row]);
      anchor.current = row;
    } else {
      selectRows([row]);
      anchor.current = row;
    }
  };

  const cellMenu = (event: MouseEvent, row: number, column: string) => {
    const rows = selectedRows.includes(row) ? selectedRows : [row];
    if (!selectedRows.includes(row)) selectRows([row]);
    setActive({ row, column });
    const value = props.rows[row]?.[column];
    showMenu(event, [
      { label: t('Copy Cell'), action: () => copyToClipboard(editableText(value)) },
      { label: rows.length > 1 ? t('Copy Rows as TSV') : t('Copy Row as TSV'), action: () => copyToClipboard(toTSV(props.columns, rows.map(index => props.rows[index]))) },
      { label: t('Copy Rows with Header'), action: () => copyToClipboard(toTSV(props.columns, rows.map(index => props.rows[index]), true)) },
      ...(props.cellMenu ? ['separator' as const, ...props.cellMenu({ row, column }, rows)] : []),
    ]);
  };

  const resize = (event: PointerEvent, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const initial = width(column);
    const header = handle.closest('.grid') as HTMLElement | null;
    let next = initial;
    let frame = 0;
    const move = (moved: PointerEvent) => {
      next = Math.max(48, Math.min(1200, initial + moved.clientX - start));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          // The drag changes one style; the widths commit on release.
          header?.style.setProperty('--grid-template', `48px ${props.columns.map(item => `${item === column ? next : width(item)}px`).join(' ')}`);
        });
      }
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      if (frame) cancelAnimationFrame(frame);
      header?.style.removeProperty('--grid-template');
      setWidths(current => ({ ...current, [column]: next }));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
  };

  if (props.columns.length === 0) return <div class="grid-empty muted">{props.emptyText ?? t('No rows.')}</div>;

  return (
    <div
      ref={scroller}
      class="grid"
      tabIndex={0}
      style={{ '--grid-template': template }}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      <div class="grid-header grid-line">
        <div class="grid-cell grid-index" />
        {props.columns.map(column => (
          <div
            key={column}
            class="grid-cell grid-heading"
            title={props.columnDetails?.[column] ? `${column}: ${props.columnDetails[column]}` : column}
            onContextMenu={event => props.headerMenu && showMenu(event, props.headerMenu(column))}
          >
            <span>{column}</span>
            {props.headerSuffix && <span class="grid-sort">{props.headerSuffix(column)}</span>}
            <span class="grid-resize" onPointerDown={event => resize(event, column)} />
          </div>
        ))}
      </div>
      <div class="grid-body" style={{ height: `${props.rows.length * ROW_HEIGHT}px` }}>
        {props.rows.length === 0 && <div class="grid-empty muted">{props.emptyText ?? t('No rows.')}</div>}
        {props.rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          return (
            <div
              key={index}
              class={`grid-line ${selectedRows.includes(index) ? 'selected' : ''} ${props.rowClass?.(index) ?? ''}`}
              style={{ top: `${index * ROW_HEIGHT}px` }}
            >
              <div class="grid-cell grid-index" onClick={event => clickCell(event, index, props.columns[0])}>
                {index + 1}
              </div>
              {props.columns.map(column => {
                const isActive = active?.row === index && active.column === column;
                const isEditing = editing?.row === index && editing.column === column;
                const value = row[column];
                return (
                  <div
                    key={column}
                    class={`grid-cell ${value === null || value === undefined ? 'null' : ''} ${isActive ? 'active' : ''} ${props.cellClass?.(index, column) ?? ''}`}
                    onClick={event => clickCell(event, index, column)}
                    onDblClick={() => props.onEdit && setEditing({ row: index, column })}
                    onContextMenu={event => cellMenu(event, index, column)}
                    title={typeof value === 'string' && value.length > 40 ? value.slice(0, 2000) : undefined}
                  >
                    {isEditing ? (
                      <CellEditor
                        initial={editableText(value)}
                        onDone={text => {
                          setEditing(null);
                          scroller.current?.focus();
                          if (text !== null && text !== editableText(value)) props.onEdit?.(index, column, text);
                        }}
                      />
                    ) : (
                      displayValue(value)
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CellEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      class="cell-editor"
      defaultValue={initial}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(event.currentTarget.value);
        if (event.key === 'Escape') finish(null);
      }}
      onBlur={event => finish(event.currentTarget.value)}
    />
  );
}
