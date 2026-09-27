import config, { type YTSource } from '../../config';
import redis from '../../module/redis';
import { ytFetch } from '../../module/proxy';
import { singleFlight } from '../../utils/singleflight';
import { LocalProvider } from './local';
import { DataApiProvider } from './dataApi';
import { HolodexProvider } from './holodex';
import { isChannelId, type ChannelLive, type ChannelMeta, type YTLiveProvider } from './types';

export * from './types';

const DEFAULT_STATUS_TTL: Record<YTSource, number> = {
  local: 60,
  holodex: 60,
  // Data API has a 10k units/day quota, every refresh costs ~1 unit per channel
  dataapi: 300,
};

const META_TTL = 24 * 3600;
const RESOLVE_TTL = 7 * 24 * 3600;

export const localProvider = new LocalProvider({ fetch: ytFetch });

function createPrimaryProvider(): YTLiveProvider {
  try {
    switch(config.youtube.source) {
      case 'dataapi':
        return new DataApiProvider({ fetch: ytFetch, apiKey: config.youtube.dataApiKey });
      case 'holodex':
        return new HolodexProvider({ fetch: ytFetch, apiKey: config.youtube.holodexApiKey });
    }
  }
  catch(e) {
    console.error(`${e}, fallback to local provider`);
  }
  return localProvider;
}

export const provider = createPrimaryProvider();

const statusTTL = config.youtube.statusCacheSeconds || DEFAULT_STATUS_TTL[provider.name as YTSource] || 60;

console.log(`YouTube live source: ${provider.name}, status cache ${statusTTL}s`);

// call the primary provider, retry with the local provider on failure
async function withFallback<T>(label: string, fn: (p: YTLiveProvider) => Promise<T>): Promise<T> {
  try {
    return await fn(provider);
  }
  catch(e) {
    if(provider === localProvider) throw e;
    console.error(`YouTube ${provider.name} ${label} failed, fallback to local:`, e);
    return await fn(localProvider);
  }
}

async function readJSONMany<T>(keys: string[]): Promise<(T | null)[]> {
  if(keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return values.map((v) => (v ? JSON.parse(v) as T : null));
}

export async function resolveChannelId(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if(isChannelId(trimmed)) return trimmed;
  const key = `yt:channel:resolve:${trimmed.toLowerCase()}`;
  const cached = await redis.get(key);
  if(cached) return cached;
  return singleFlight(key, async () => {
    const resolver = provider.resolveChannelIds ? provider : localProvider;
    let map: Map<string, string>;
    try {
      map = await resolver.resolveChannelIds!([trimmed]);
    }
    catch(e) {
      if(resolver === localProvider) throw e;
      console.error(`YouTube ${resolver.name} resolve failed, fallback to local:`, e);
      map = await localProvider.resolveChannelIds([trimmed]);
    }
    const id = map.get(trimmed);
    if(!id) return null;
    await redis.set(key, id, 'EX', RESOLVE_TTL);
    return id;
  });
}

export async function getChannelStatus(channelIds: string[]): Promise<Map<string, ChannelLive>> {
  const unique = Array.from(new Set(channelIds));
  const cached = await readJSONMany<ChannelLive>(unique.map((id) => `yt:status:${id}`));
  const result = new Map<string, ChannelLive>();
  const missing: string[] = [];
  unique.forEach((id, i) => {
    if(cached[i]) result.set(id, cached[i]!);
    else missing.push(id);
  });
  if(missing.length > 0) {
    const fetched = await singleFlight(`yt:status:${missing.sort().join(',')}`, async () => {
      const statuses = await withFallback('status', (p) => p.getStatus(missing));
      const pipeline = redis.pipeline();
      for(const [id, status] of statuses) {
        pipeline.set(`yt:status:${id}`, JSON.stringify(status), 'EX', statusTTL);
        // sources like holodex return channel info with the status, keep it as meta
        if(status.channelName) {
          pipeline.set(`yt:meta:${id}`, JSON.stringify({ channelId: id, name: status.channelName, avatar: status.channelAvatar } satisfies ChannelMeta), 'EX', META_TTL, 'NX');
        }
      }
      await pipeline.exec();
      return statuses;
    });
    for(const [id, status] of fetched) result.set(id, status);
  }
  return result;
}

export async function getOneChannelStatus(channelId: string): Promise<ChannelLive> {
  return (await getChannelStatus([channelId])).get(channelId) || { channelId, status: 'offline' };
}

export async function getChannelMeta(channelIds: string[]): Promise<Map<string, ChannelMeta>> {
  const unique = Array.from(new Set(channelIds));
  const cached = await readJSONMany<ChannelMeta>(unique.map((id) => `yt:meta:${id}`));
  const result = new Map<string, ChannelMeta>();
  const missing: string[] = [];
  unique.forEach((id, i) => {
    if(cached[i]?.avatar) result.set(id, cached[i]!);
    else missing.push(id);
  });
  if(missing.length > 0) {
    try {
      const fetched = await singleFlight(`yt:meta:${missing.sort().join(',')}`, async () => {
        const metas = await withFallback('meta', (p) => p.getChannelMeta(missing));
        const pipeline = redis.pipeline();
        for(const [id, meta] of metas) {
          pipeline.set(`yt:meta:${id}`, JSON.stringify(meta), 'EX', META_TTL);
        }
        await pipeline.exec();
        return metas;
      });
      for(const [id, meta] of fetched) result.set(id, meta);
    }
    catch(e) {
      console.error('Failed to fetch YouTube channel meta:', e);
      unique.forEach((id, i) => {
        if(!result.has(id) && cached[i]) result.set(id, cached[i]!);
      });
    }
  }
  return result;
}

export async function getOrgLive(): Promise<ChannelLive[]> {
  const orgs = config.youtube.holodexOrgs;
  if(orgs.length === 0 || !provider.getOrgLive) return [];
  const key = `yt:org:${orgs.join(',')}`;
  const cached = await redis.get(key);
  if(cached) return JSON.parse(cached);
  return singleFlight(key, async () => {
    const list = await provider.getOrgLive!(orgs);
    const pipeline = redis.pipeline();
    pipeline.set(key, JSON.stringify(list), 'EX', statusTTL);
    for(const status of list) {
      pipeline.set(`yt:status:${status.channelId}`, JSON.stringify(status), 'EX', statusTTL);
      if(status.channelName) {
        pipeline.set(`yt:meta:${status.channelId}`, JSON.stringify({ channelId: status.channelId, name: status.channelName, avatar: status.channelAvatar }), 'EX', META_TTL, 'NX');
      }
    }
    await pipeline.exec();
    return list;
  });
}

export interface SubscribedChannel {
  channelId: string;
  name?: string;
  group: string;
}

// configured channels plus holodex organization channels that are live / upcoming
export async function listSubscribedChannels(): Promise<SubscribedChannel[]> {
  const result: SubscribedChannel[] = [];
  const seen = new Set<string>();
  const resolved = await Promise.all(config.youtube.channels.map(async (channel) => {
    try {
      const channelId = await resolveChannelId(channel.id);
      if(!channelId) console.error(`Failed to resolve YouTube channel ${channel.id}`);
      return channelId;
    }
    catch(e) {
      console.error(`Failed to resolve YouTube channel ${channel.id}:`, e);
      return null;
    }
  }));
  for(const [i, channel] of config.youtube.channels.entries()) {
    const channelId = resolved[i];
    if(!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    result.push({ channelId, name: channel.name, group: channel.group || 'YouTube' });
  }
  try {
    for(const live of await getOrgLive()) {
      if(seen.has(live.channelId)) continue;
      seen.add(live.channelId);
      result.push({ channelId: live.channelId, name: live.channelName, group: 'Holodex' });
    }
  }
  catch(e) {
    console.error('Failed to fetch Holodex organization live list:', e);
  }
  return result;
}
