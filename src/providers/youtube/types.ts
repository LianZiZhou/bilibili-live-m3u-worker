import type { FetchLike } from '../../module/proxy';

export type LiveStatus = 'live' | 'upcoming' | 'offline';

export interface ChannelLive {
  channelId: string;
  status: LiveStatus;
  videoId?: string;
  title?: string;
  thumbnail?: string;
  // unix ms, actual start for live, scheduled start for upcoming
  startTime?: number;
  // channel info returned alongside the status, if the source provides it
  channelName?: string;
  channelAvatar?: string;
}

export interface ChannelMeta {
  channelId: string;
  name: string;
  avatar?: string;
}

export interface YTLiveProvider {
  readonly name: string;
  // resolve handles (@xxx) to channel ids (UC...), keyed by input
  resolveChannelIds?(inputs: string[]): Promise<Map<string, string>>;
  getStatus(channelIds: string[]): Promise<Map<string, ChannelLive>>;
  getChannelMeta(channelIds: string[]): Promise<Map<string, ChannelMeta>>;
  // channels currently live/upcoming in the given organizations (holodex only)
  getOrgLive?(orgs: string[]): Promise<ChannelLive[]>;
}

export interface ProviderOptions {
  fetch: FetchLike;
}

export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // skip the EU cookie consent page
  'Cookie': 'SOCS=CAI',
};

export function isChannelId(value: string) {
  return /^UC[\w-]{22}$/.test(value);
}

export function chunk<T>(list: T[], size: number): T[][] {
  const result: T[][] = [];
  for(let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

export function videoThumbnail(videoId: string) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// pick the best stream for a channel: live first, then the nearest upcoming
export function pickBest(candidates: ChannelLive[]): ChannelLive | undefined {
  const live = candidates.filter((c) => c.status === 'live')
    .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  if(live.length > 0) return live[0];
  const upcoming = candidates.filter((c) => c.status === 'upcoming')
    .sort((a, b) => (a.startTime || Infinity) - (b.startTime || Infinity));
  return upcoming[0];
}

// Promise.all with a concurrency limit
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while(next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
