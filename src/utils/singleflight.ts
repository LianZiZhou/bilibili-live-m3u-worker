const inflight = new Map<string, Promise<unknown>>();

/**
 * Run fn once per key at a time: concurrent callers with the same key share
 * the same promise instead of repeating the work.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if(existing) {
    return existing as Promise<T>;
  }
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
