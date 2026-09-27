import { chunk, mapLimit, pickBest, videoThumbnail, type ChannelLive, type ChannelMeta, type ProviderOptions, type YTLiveProvider } from './types';

const API = 'https://holodex.net/api/v2';

export function parseHolodexVideos(videos: any[]): ChannelLive[] {
  const result: ChannelLive[] = [];
  for(const video of Array.isArray(videos) ? videos : []) {
    if(video.type && video.type !== 'stream') continue;
    // members only streams can't be played without a membership
    if(video.topic_id === 'membersonly') continue;
    if(video.status !== 'live' && video.status !== 'upcoming') continue;
    const channel = video.channel || {};
    const start = video.status === 'live' ? (video.start_actual || video.start_scheduled) : video.start_scheduled;
    result.push({
      channelId: channel.id || video.channel_id,
      status: video.status,
      videoId: video.id,
      title: video.title,
      thumbnail: videoThumbnail(video.id),
      startTime: start ? Date.parse(start) : undefined,
      channelName: channel.name,
      channelAvatar: channel.photo,
    });
  }
  return result;
}

export class HolodexProvider implements YTLiveProvider {
  readonly name = 'holodex';

  constructor(private readonly options: ProviderOptions & { apiKey: string }) {
    if(!options.apiKey) {
      throw new Error('Holodex API key is not configured (youtube.holodexApiKey / HOLODEX_API_KEY)');
    }
  }

  private async api(path: string, params: Record<string, string> = {}) {
    const search = new URLSearchParams(params);
    const response = await this.options.fetch(`${API}/${path}${search.size > 0 ? '?' + search : ''}`, {
      headers: { 'X-APIKEY': this.options.apiKey },
    });
    if(response.status !== 200) {
      throw new Error(`Holodex ${path} failed, status: ${response.status}`);
    }
    return await response.json() as any;
  }

  async getStatus(channelIds: string[]) {
    const candidates: ChannelLive[] = [];
    for(const ids of chunk(channelIds, 50)) {
      candidates.push(...parseHolodexVideos(await this.api('users/live', { channels: ids.join(',') })));
    }
    const result = new Map<string, ChannelLive>();
    for(const channelId of channelIds) {
      const best = pickBest(candidates.filter((c) => c.channelId === channelId));
      result.set(channelId, best || { channelId, status: 'offline' });
    }
    return result;
  }

  async getChannelMeta(channelIds: string[]) {
    const result = new Map<string, ChannelMeta>();
    await mapLimit(channelIds, 4, async (channelId) => {
      const channel = await this.api(`channels/${encodeURIComponent(channelId)}`);
      result.set(channelId, {
        channelId,
        name: channel.name || channel.english_name || channelId,
        avatar: channel.photo,
      });
    });
    return result;
  }

  async getOrgLive(orgs: string[]) {
    const result: ChannelLive[] = [];
    for(const org of orgs) {
      const videos = await this.api('live', { org, type: 'stream', limit: '50', max_upcoming_hours: '48' });
      result.push(...parseHolodexVideos(videos));
    }
    // one entry per channel
    const byChannel = new Map<string, ChannelLive[]>();
    for(const item of result) {
      byChannel.set(item.channelId, [...(byChannel.get(item.channelId) || []), item]);
    }
    return Array.from(byChannel.values()).map((items) => pickBest(items)!).filter(Boolean);
  }
}
