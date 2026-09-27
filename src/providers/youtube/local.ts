import { BROWSER_HEADERS, isChannelId, mapLimit, videoThumbnail, type ChannelLive, type ChannelMeta, type ProviderOptions, type YTLiveProvider } from './types';

// Extract a JSON object literal assigned in a script, e.g. `var ytInitialPlayerResponse = {...};`
export function extractJSONAfter(html: string, marker: string): any | null {
  const start = html.indexOf(marker);
  if(start < 0) return null;
  let i = html.indexOf('{', start + marker.length);
  if(i < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for(let j = i; j < html.length; j++) {
    const ch = html[j];
    if(inString) {
      if(escaped) escaped = false;
      else if(ch === '\\') escaped = true;
      else if(ch === '"') inString = false;
      continue;
    }
    if(ch === '"') inString = true;
    else if(ch === '{') depth++;
    else if(ch === '}') {
      depth--;
      if(depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        }
        catch {
          return null;
        }
      }
    }
  }
  return null;
}

function decodeEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function metaContent(html: string, property: string): string | undefined {
  const m = html.match(new RegExp(`<meta (?:property|name|itemprop)="${property}" content="([^"]*)"`));
  return m ? decodeEntities(m[1]) : undefined;
}

function canonical(html: string): string | undefined {
  const m = html.match(/<link rel="canonical" href="([^"]*)"/);
  return m ? m[1] : undefined;
}

export function channelPath(idOrHandle: string) {
  return idOrHandle.startsWith('@') ? idOrHandle : `channel/${idOrHandle}`;
}

// Parse https://www.youtube.com/channel/<id>/live
export function parseLivePage(channelId: string, html: string): ChannelLive {
  const player = extractJSONAfter(html, 'var ytInitialPlayerResponse = ');
  const details = player?.videoDetails || {};
  const data = extractJSONAfter(html, 'var ytInitialData = ');
  const watchContents: any[] = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  const primary = watchContents.find((c) => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
  // the page embeds the current (or next scheduled) stream; the player response can be
  // withheld ("confirm you're not a bot") and canonical can be missing, so try every source
  const videoId: string | undefined = details.videoId
    || data?.currentVideoEndpoint?.watchEndpoint?.videoId
    || (canonical(html) || '').match(/[?&]v=([\w-]{11})/)?.[1];
  if(!videoId) {
    const meta = parseChannelPage(html);
    return { channelId, status: 'offline', channelName: meta?.name, channelAvatar: meta?.avatar };
  }
  const broadcast = player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};
  const slate = player?.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer?.offlineSlate?.liveStreamOfflineSlateRenderer;
  const viewCount = primary?.viewCount?.videoViewCountRenderer;
  const dateText: string = primary?.dateText?.simpleText || '';
  let status: ChannelLive['status'] = 'offline';
  if(details.isLive || broadcast.isLiveNow || (!player?.videoDetails && viewCount?.isLive)) {
    status = 'live';
  }
  else if(details.isUpcoming || slate?.scheduledStartTime || (!player?.videoDetails && /^(Scheduled|Premieres)/i.test(dateText))) {
    status = 'upcoming';
  }
  let startTime: number | undefined;
  if(slate?.scheduledStartTime) {
    startTime = Number(slate.scheduledStartTime) * 1000;
  }
  else if(broadcast.startTimestamp) {
    startTime = Date.parse(broadcast.startTimestamp);
  }
  if(status === 'offline') {
    return { channelId, status };
  }
  const owner = watchContents.find((c) => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
  return {
    channelId,
    status,
    videoId,
    title: details.title || primary?.title?.runs?.map((r: any) => r.text).join('') || metaContent(html, 'og:title'),
    thumbnail: videoThumbnail(videoId),
    startTime,
    channelName: details.author || owner?.title?.runs?.[0]?.text,
  };
}

// Parse https://www.youtube.com/channel/<id> (or /@handle)
export function parseChannelPage(html: string): ChannelMeta | null {
  const data = extractJSONAfter(html, 'var ytInitialData = ');
  const md = data?.metadata?.channelMetadataRenderer;
  const id = md?.externalId
    || metaContent(html, 'identifier')
    || (canonical(html) || '').match(/\/channel\/(UC[\w-]{22})/)?.[1];
  if(!id || !isChannelId(id)) return null;
  return {
    channelId: id,
    name: md?.title || metaContent(html, 'og:title') || id,
    avatar: md?.avatar?.thumbnails?.[0]?.url || metaContent(html, 'og:image'),
  };
}

// parallel page requests to youtube.com
const CONCURRENCY = 6;

export class LocalProvider implements YTLiveProvider {
  readonly name = 'local';

  constructor(private readonly options: ProviderOptions) {}

  private async fetchPage(url: string): Promise<string> {
    const response = await this.options.fetch(url, { headers: BROWSER_HEADERS });
    if(response.status === 404) {
      // unknown channel / handle
      return '';
    }
    if(response.status !== 200) {
      throw new Error(`Failed to fetch ${url}, status: ${response.status}`);
    }
    return await response.text();
  }

  async resolveChannelIds(inputs: string[]) {
    const result = new Map<string, string>();
    await mapLimit(inputs, CONCURRENCY, async (input) => {
      if(isChannelId(input)) {
        result.set(input, input);
        return;
      }
      const meta = parseChannelPage(await this.fetchPage(`https://www.youtube.com/${channelPath(input)}`));
      if(meta) result.set(input, meta.channelId);
    });
    return result;
  }

  async getStatus(channelIds: string[]) {
    const result = new Map<string, ChannelLive>();
    await mapLimit(channelIds, CONCURRENCY, async (channelId) => {
      const html = await this.fetchPage(`https://www.youtube.com/${channelPath(channelId)}/live`);
      result.set(channelId, parseLivePage(channelId, html));
    });
    return result;
  }

  async getChannelMeta(channelIds: string[]) {
    const result = new Map<string, ChannelMeta>();
    await mapLimit(channelIds, CONCURRENCY, async (channelId) => {
      const meta = parseChannelPage(await this.fetchPage(`https://www.youtube.com/${channelPath(channelId)}`));
      if(meta) result.set(channelId, { ...meta, channelId });
    });
    return result;
  }
}
