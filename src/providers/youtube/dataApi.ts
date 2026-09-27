import { chunk, isChannelId, pickBest, videoThumbnail, type ChannelLive, type ChannelMeta, type ProviderOptions, type YTLiveProvider } from './types';

const API = 'https://www.googleapis.com/youtube/v3';

// how many recent uploads per channel are checked for live/upcoming broadcasts
const RECENT_UPLOADS = 10;

// ignore upcoming "frames" scheduled too far away or long overdue
const UPCOMING_MAX_AHEAD = 7 * 24 * 3600 * 1000;
const UPCOMING_MAX_OVERDUE = 24 * 3600 * 1000;

export function parseVideosResponse(items: any[], now = Date.now()): ChannelLive[] {
  const result: ChannelLive[] = [];
  for(const item of items || []) {
    const snippet = item.snippet || {};
    const live = item.liveStreamingDetails || {};
    const content = snippet.liveBroadcastContent;
    if(content !== 'live' && content !== 'upcoming') continue;
    const startTime = content === 'live'
      ? Date.parse(live.actualStartTime || live.scheduledStartTime || '') || undefined
      : Date.parse(live.scheduledStartTime || '') || undefined;
    if(content === 'upcoming' && startTime && (startTime - now > UPCOMING_MAX_AHEAD || now - startTime > UPCOMING_MAX_OVERDUE)) {
      continue;
    }
    result.push({
      channelId: snippet.channelId,
      status: content,
      videoId: item.id,
      title: snippet.title,
      thumbnail: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || videoThumbnail(item.id),
      startTime,
      channelName: snippet.channelTitle,
    });
  }
  return result;
}

export class DataApiProvider implements YTLiveProvider {
  readonly name = 'dataapi';

  constructor(private readonly options: ProviderOptions & { apiKey: string }) {
    if(!options.apiKey) {
      throw new Error('YouTube Data API key is not configured (youtube.dataApiKey / YT_DATA_API_KEY)');
    }
  }

  private async api(path: string, params: Record<string, string>) {
    const search = new URLSearchParams({ ...params, key: this.options.apiKey });
    const response = await this.options.fetch(`${API}/${path}?${search}`);
    const data = await response.json() as any;
    if(response.status !== 200) {
      const error = new Error(`YouTube Data API ${path} failed, status: ${response.status}, ${data?.error?.message || ''}`);
      (error as any).status = response.status;
      throw error;
    }
    return data;
  }

  async resolveChannelIds(inputs: string[]) {
    const result = new Map<string, string>();
    await Promise.all(inputs.map(async (input) => {
      if(isChannelId(input)) {
        result.set(input, input);
        return;
      }
      const data = await this.api('channels', { part: 'id', forHandle: input });
      if(data.items?.[0]?.id) result.set(input, data.items[0].id);
    }));
    return result;
  }

  async getChannelMeta(channelIds: string[]) {
    const result = new Map<string, ChannelMeta>();
    for(const ids of chunk(channelIds, 50)) {
      const data = await this.api('channels', { part: 'snippet', id: ids.join(','), maxResults: '50' });
      for(const item of data.items || []) {
        const thumbs = item.snippet?.thumbnails || {};
        result.set(item.id, {
          channelId: item.id,
          name: item.snippet?.title || item.id,
          avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url,
        });
      }
    }
    return result;
  }

  async getStatus(channelIds: string[]) {
    // 1 quota unit per channel: recent uploads from the channel's uploads playlist
    const videoIds: string[] = [];
    await Promise.all(channelIds.map(async (channelId) => {
      try {
        const data = await this.api('playlistItems', {
          part: 'contentDetails',
          playlistId: 'UU' + channelId.slice(2),
          maxResults: String(RECENT_UPLOADS),
        });
        for(const item of data.items || []) {
          if(item.contentDetails?.videoId) videoIds.push(item.contentDetails.videoId);
        }
      }
      catch(e: any) {
        // channel without uploads playlist, treat as offline
        if(e.status !== 404) throw e;
      }
    }));
    // 1 quota unit per 50 videos
    const candidates: ChannelLive[] = [];
    for(const ids of chunk(videoIds, 50)) {
      const data = await this.api('videos', { part: 'snippet,liveStreamingDetails', id: ids.join(','), maxResults: '50' });
      candidates.push(...parseVideosResponse(data.items));
    }
    const result = new Map<string, ChannelLive>();
    for(const channelId of channelIds) {
      const best = pickBest(candidates.filter((c) => c.channelId === channelId));
      result.set(channelId, best || { channelId, status: 'offline' });
    }
    return result;
  }
}
