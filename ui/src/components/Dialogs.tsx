import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n.ts';
import { closeDialog, useStore, type Dialog } from '../store.ts';
import { ProfileEditor } from './ProfileEditor.tsx';
import { DBXImport } from './DBXImport.tsx';

export function Dialogs() {
  const dialogs = useStore(state => state.dialogs);
  const top = dialogs.at(-1);
  if (!top) return null;
  return <DialogView key={dialogs.length} dialog={top} />;
}

function DialogView({ dialog }: { dialog: Dialog }) {
  switch (dialog.kind) {
    case 'confirm':
      return <Confirm dialog={dialog} />;
    case 'prompt':
      return <Prompt dialog={dialog} />;
    case 'choice':
      return <Choice dialog={dialog} />;
    case 'profile':
      return <ProfileEditor dialog={dialog} />;
    case 'dbx':
      return <DBXImport dialog={dialog} />;
  }
}

/** A modal sheet; Escape and the backdrop cancel. */
export function Modal(props: { title: string; onCancel: () => void; wide?: boolean; children: ComponentChildren; footer: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = panel.current;
    element?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && props.onCancel()}>
      <div ref={panel} class={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        <div class="modal-body">{props.children}</div>
        <div class="modal-footer">{props.footer}</div>
      </div>
    </div>
  );
}

function Confirm({ dialog }: { dialog: Extract<Dialog, { kind: 'confirm' }> }) {
  const finish = (ok: boolean) => {
    closeDialog(dialog);
    dialog.resolve(ok);
  };
  return (
    <Modal
      title={dialog.title}
      onCancel={() => finish(false)}
      footer={
        <>
          <button onClick={() => finish(false)}>{t('Cancel')}</button>
          <button class={`primary ${dialog.destructive ? 'destructive' : ''}`} onClick={() => finish(true)}>
            {dialog.confirmLabel}
          </button>
        </>
      }
    >
      <p class="preformatted">{dialog.message}</p>
    </Modal>
  );
}

function Prompt({ dialog }: { dialog: Extract<Dialog, { kind: 'prompt' }> }) {
  const [value, setValue] = useState(dialog.value);
  const finish = (result: string | null) => {
    closeDialog(dialog);
    dialog.resolve(result);
  };
  return (
    <Modal
      title={dialog.title}
      onCancel={() => finish(null)}
      footer={
        <>
          <button onClick={() => finish(null)}>{t('Cancel')}</button>
          <button class="primary" disabled={!value.trim()} onClick={() => finish(value)}>
            {dialog.confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          if (value.trim()) finish(value);
        }}
      >
        <label class="field">
          <span>{dialog.label}</span>
          <input autofocus value={value} onInput={event => setValue(event.currentTarget.value)} />
        </label>
      </form>
    </Modal>
  );
}

function Choice({ dialog }: { dialog: Extract<Dialog, { kind: 'choice' }> }) {
  const [selected, setSelected] = useState(dialog.options[0]?.id ?? '');
  const finish = (result: string | null) => {
    closeDialog(dialog);
    dialog.resolve(result);
  };
  return (
    <Modal
      title={dialog.title}
      onCancel={() => finish(null)}
      footer={
        <>
          <button onClick={() => finish(null)}>{t('Cancel')}</button>
          <button class="primary" disabled={!selected} onClick={() => finish(selected)}>
            {t('Choose')}
          </button>
        </>
      }
    >
      <select size={Math.min(12, Math.max(4, dialog.options.length))} class="list-select" value={selected} onInput={event => setSelected(event.currentTarget.value)} onDblClick={() => finish(selected)}>
        {dialog.options.map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </Modal>
  );
}
