// The host bridge: Lithe defines `window.lithe` before any page script runs.
// Function calls without an instance go to this plugin's backend, which
// Lithe starts on the first call.

export interface BridgeError {
  code: string;
  message: string;
  pluginErrorCode?: string;
}

interface Lithe {
  version: number;
  context: { pluginID: string; windowID: string; platform: string; locale: string; theme: string };
  request(method: string, params?: unknown): Promise<any>;
  on(event: string, listener: (payload: any) => void): () => void;
}

declare global {
  interface Window {
    lithe?: Lithe;
  }
}

/** The bridge, or a stand-in that refuses everything outside Lithe. */
export const lithe: Lithe = window.lithe ?? {
  version: 0,
  context: { pluginID: '', windowID: '', platform: 'web', locale: navigator.language, theme: 'light' },
  request: () => Promise.reject({ code: 'plugin.web.unavailable', message: 'This page runs only inside Lithe.' }),
  on: () => () => {},
};

let calls = 0;
const progressListeners = new Map<string, (message: string | undefined, percentage: number | undefined) => void>();

lithe.on('functions.progress', ({ call, message, percentage }) => {
  progressListeners.get(call)?.(message, percentage);
});

export interface Call<T> {
  result: Promise<T>;
  cancel(): void;
}

/** Calls a backend function; `onProgress` receives its progress reports. */
export function invoke<T = any>(
  fn: string,
  params: object = {},
  onProgress?: (message: string | undefined, percentage: number | undefined) => void,
): Call<T> {
  const call = `${fn}-${Date.now().toString(36)}-${(calls++).toString(36)}`;
  if (onProgress) progressListeners.set(call, onProgress);
  const result = lithe
    .request('functions.invoke', { function: fn, params, call })
    .then(({ value }) => value as T)
    .finally(() => progressListeners.delete(call));
  return {
    result,
    cancel: () => {
      lithe.request('functions.cancel', { call }).catch(() => {});
    },
  };
}

export function isBridgeError(error: unknown): error is BridgeError {
  return typeof error === 'object' && error !== null && typeof (error as BridgeError).code === 'string';
}

/** The plugin's own error code, else the host's. */
export function errorCode(error: unknown): string | undefined {
  return isBridgeError(error) ? (error.pluginErrorCode ?? error.code) : undefined;
}

export function errorMessage(error: unknown): string {
  if (isBridgeError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** File dialogs arrived with bridge version 2. */
export const hasFileDialogs = lithe.version >= 2;

/** The absolute path the user chose, or null when they cancelled. */
export async function chooseFile(
  kind: 'open' | 'save',
  options: { title?: string; suggestedName?: string; extensions?: string[] } = {},
): Promise<string | null> {
  const method = kind === 'open' ? 'dialog.openFile' : 'dialog.saveFile';
  const params: Record<string, unknown> = { ...options };
  if (kind === 'open') delete params.suggestedName;
  const { path } = await lithe.request(method, params);
  return path ?? null;
}

export async function getState<T>(): Promise<T | null> {
  try {
    const { state } = await lithe.request('ui.getState');
    return (state as T) ?? null;
  } catch {
    return null;
  }
}

let pendingState: unknown;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

/** Saves page state soon; repeated saves within the delay write once. */
export function saveState(state: unknown): void {
  pendingState = state;
  if (stateTimer !== undefined) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    lithe.request('ui.setState', { state: pendingState }).catch(() => {});
  }, 400);
}
