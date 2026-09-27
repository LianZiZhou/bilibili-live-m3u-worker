import type { Context } from 'hono';
import redis from '../module/redis';
import { singleFlight } from './singleflight';
import type { FetchLike } from '../module/proxy';

export interface CachedBinary {
  body: Buffer;
  type: string;
}

export async function getCachedBinary(key: string): Promise<CachedBinary | null> {
  const [[, body], [, type]] = await redis.multi().getBuffer(key).get(`${key}:type`).exec() as [[unknown, Buffer | null], [unknown, string | null]];
  if(!body) {
    return null;
  }
  return { body, type: type || 'application/octet-stream' };
}

export async function setCachedBinary(key: string, value: CachedBinary, ttlSeconds: number) {
  await redis.multi()
    .set(key, value.body, 'EX', ttlSeconds)
    .set(`${key}:type`, value.type, 'EX', ttlSeconds)
    .exec();
}

export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export function sendBinary(c: Context, value: CachedBinary) {
  c.header('content-type', value.type);
  return c.body(toArrayBuffer(value.body));
}

/**
 * Fetch a remote image (or any small file) and cache it in redis.
 * Returns null when the upstream is unavailable.
 */
export async function fetchCachedImage(key: string, url: string, ttlSeconds: number, fetcher: FetchLike = fetch): Promise<CachedBinary | null> {
  const cached = await getCachedBinary(key);
  if(cached) {
    return cached;
  }
  return singleFlight(`image:${key}`, async () => {
    const response = await fetcher(url);
    if(response.status !== 200) {
      return null;
    }
    const value = {
      body: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get('content-type') || 'application/octet-stream',
    };
    await setCachedBinary(key, value, ttlSeconds);
    return value;
  });
}
