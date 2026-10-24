// Requests whose answer only matters while no newer request of the same
// kind replaced them, such as loading the selected key or a list page.
import { useEffect, useState } from 'preact/hooks';
import type { Call } from './bridge.ts';

/** The answer of a request that a newer one replaced. */
export const STALE = Symbol('stale');

/**
 * One request of a kind at a time: a new request cancels the previous one,
 * whose answer, or failure, then resolves to `STALE`.
 */
export class LatestCall {
  private current: Call<unknown> | null = null;

  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }

  async run<T>(call: Call<T>): Promise<T | typeof STALE> {
    this.current?.cancel();
    this.current = call;
    try {
      const value = await call.result;
      return this.current === call ? value : STALE;
    } catch (error) {
      if (this.current !== call) return STALE;
      throw error;
    } finally {
      if (this.current === call) this.current = null;
    }
  }
}

/** A `LatestCall` that cancels its request when the component goes away. */
export function useLatestCall(): LatestCall {
  const [latest] = useState(() => new LatestCall());
  useEffect(() => () => latest.cancel(), []);
  return latest;
}
