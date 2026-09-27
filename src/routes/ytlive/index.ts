import { Hono, type Context } from 'hono';
import { parseQuality, type YTPlayback } from '../../config';
import { ytFetch } from '../../module/proxy';
import { buildLivePlaylist, getMuxSegment, getPassthroughSegment, LIVE_SEQ_OFFSET } from '../../module/youtube/playback';
import { buildPlaceholderPlaylist, getPlaceholderSegment } from '../../module/youtube/placeholder';
import { getChannelMeta, getChannelStatus, getOneChannelStatus, listSubscribedChannels, resolveChannelId, videoThumbnail, type ChannelLive } from '../../providers/youtube';
import { fetchCachedImage, sendBinary, toArrayBuffer } from '../../utils/binaryCache';
import { renderM3U, renderXMLTV, type M3UEntry, type XMLTVChannel, type XMLTVProgramme } from '../../utils/playlist';
import { getBaseUrl } from '../../utils/request';

const app = new Hono();

const M3U8_TYPE = 'application/vnd.apple.mpegurl';

function playbackOptions(c: Context) {
  const mode = c.req.query('mode');
  const quality = c.req.query('quality');
  return {
    mode: mode === 'mux' || mode === 'passthrough' ? mode as YTPlayback : undefined,
    quality: quality !== undefined ? parseQuality(quality) : undefined,
  };
}

function sendPlaylist(c: Context, text: string, log: string) {
  c.header('content-type', M3U8_TYPE);
  c.header('cache-control', 'no-cache');
  // @ts-ignore
  c.set('log', log);
  return c.body(text);
}

async function livePlaylistOrPlaceholder(c: Context, videoId: string | undefined, seqOffset: number) {
  const base = getBaseUrl(c);
  if(videoId) {
    try {
      const playlist = await buildLivePlaylist(base, videoId, { ...playbackOptions(c), seqOffset });
      if(playlist) {
        return sendPlaylist(c, playlist, `<-- YouTube ${videoId}`);
      }
    }
    catch(e) {
      console.error(`Failed to build YouTube playlist for ${videoId}:`, e);
    }
  }
  return sendPlaylist(c, buildPlaceholderPlaylist(base), 'Placeholder');
}

// stable url for a channel: plays the current live stream, or the placeholder when offline
app.get('/play/live/yt/channel/:channel/index.m3u8', async (c) => {
  const input = decodeURIComponent(c.req.param('channel'));
  let channelId: string | null = null;
  try {
    channelId = await resolveChannelId(input);
  }
  catch(e) {
    console.error(`Failed to resolve YouTube channel ${input}:`, e);
  }
  if(!channelId) {
    c.status(404);
    return c.text('Channel not found');
  }
  let status: ChannelLive | undefined;
  try {
    status = await getOneChannelStatus(channelId);
  }
  catch(e) {
    console.error(`Failed to fetch YouTube channel status ${channelId}:`, e);
  }
  return livePlaylistOrPlaceholder(c, status?.status === 'live' ? status.videoId : undefined, LIVE_SEQ_OFFSET);
});

app.get('/play/live/yt/offline/:n', async (c) => {
  const segment = await getPlaceholderSegment();
  c.header('content-type', 'video/mp2t');
  c.header('cache-control', 'public, max-age=86400');
  return c.body(toArrayBuffer(segment));
});

app.get('/play/live/yt/:video/index.m3u8', async (c) => {
  return livePlaylistOrPlaceholder(c, c.req.param('video'), 0);
});

app.get('/play/live/yt/:video/mux/:seq', async (c) => {
  const videoId = c.req.param('video');
  const seq = parseInt(c.req.param('seq'), 10);
  if(!Number.isFinite(seq)) {
    c.status(400);
    return c.text('Bad segment');
  }
  const segment = await getMuxSegment(videoId, seq).catch((e) => {
    console.error(e);
    return null;
  });
  if(!segment) {
    c.status(404);
    return c.text('Segment unavailable');
  }
  return sendBinary(c, segment);
});

app.get('/play/live/yt/:video/:itag/:seq', async (c) => {
  const videoId = c.req.param('video');
  const itag = c.req.param('itag');
  const seq = parseInt(c.req.param('seq'), 10);
  if(!Number.isFinite(seq)) {
    c.status(400);
    return c.text('Bad segment');
  }
  const segment = await getPassthroughSegment(videoId, itag, seq).catch((e) => {
    console.error(e);
    return null;
  });
  if(!segment) {
    c.status(404);
    return c.text('Segment unavailable');
  }
  return sendBinary(c, segment);
});

interface YTChannelView {
  channelId: string;
  name: string;
  group: string;
  avatar?: string;
  status: ChannelLive;
}

async function collectChannels(): Promise<YTChannelView[]> {
  const channels = await listSubscribedChannels();
  const ids = channels.map((ch) => ch.channelId);
  const [statuses, metas] = await Promise.all([
    getChannelStatus(ids).catch((e) => {
      console.error('Failed to fetch YouTube channel status:', e);
      return new Map<string, ChannelLive>();
    }),
    getChannelMeta(ids).catch((e) => {
      console.error('Failed to fetch YouTube channel meta:', e);
      return new Map();
    }),
  ]);
  return channels.map((ch) => {
    const meta = metas.get(ch.channelId);
    const status = statuses.get(ch.channelId) || { channelId: ch.channelId, status: 'offline' as const };
    return {
      channelId: ch.channelId,
      name: ch.name || meta?.name || status.channelName || ch.channelId,
      group: ch.group,
      avatar: meta?.avatar || status.channelAvatar,
      status,
    };
  });
}

export async function buildYTM3UEntries(base: string): Promise<M3UEntry[]> {
  return (await collectChannels()).map((ch) => ({
    id: `yt-${ch.channelId}`,
    name: ch.name,
    logo: `${base}/meta/live/yt/avatar/${ch.channelId}.jpg`,
    group: ch.group,
    url: `${base}/play/live/yt/channel/${ch.channelId}/index.m3u8`,
  }));
}

function formatScheduled(ms: number) {
  // UTC+8, the audience of this service is mostly in China
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export async function buildYTGuide(base: string): Promise<{ channels: XMLTVChannel[]; programmes: XMLTVProgramme[] }> {
  const views = await collectChannels();
  const now = Date.now();
  const epochStart = new Date('2024-01-01T00:00:00Z');
  const epochEnd = new Date('2077-01-01T00:00:00Z');
  const channels: XMLTVChannel[] = [];
  const programmes: XMLTVProgramme[] = [];
  for(const ch of views) {
    const id = `yt-${ch.channelId}`;
    const channelUrl = `https://www.youtube.com/channel/${ch.channelId}`;
    channels.push({ id, name: ch.name, icon: `${base}/meta/live/yt/avatar/${ch.channelId}.jpg`, url: channelUrl });
    const { status } = ch;
    const cover = `${base}/meta/live/yt/cover/${ch.channelId}.jpg`;
    if(status.status === 'live') {
      programmes.push({
        channel: id,
        start: new Date(Math.min(status.startTime || now, now)),
        stop: epochEnd,
        title: status.title || ch.name,
        icon: cover,
        url: `https://www.youtube.com/watch?v=${status.videoId}`,
      });
    }
    else if(status.status === 'upcoming' && status.startTime && status.startTime > now) {
      programmes.push({
        channel: id,
        start: epochStart,
        stop: new Date(status.startTime),
        title: `【预定 ${formatScheduled(status.startTime)}】${status.title || ch.name}`,
        icon: cover,
        url: channelUrl,
      });
      programmes.push({
        channel: id,
        start: new Date(status.startTime),
        stop: epochEnd,
        title: status.title || ch.name,
        icon: cover,
        url: `https://www.youtube.com/watch?v=${status.videoId}`,
      });
    }
    else if(status.status === 'upcoming') {
      programmes.push({
        channel: id,
        start: epochStart,
        stop: epochEnd,
        title: `【待机中】${status.title || ch.name}`,
        icon: cover,
        url: `https://www.youtube.com/watch?v=${status.videoId}`,
      });
    }
    else {
      programmes.push({
        channel: id,
        start: epochStart,
        stop: epochEnd,
        title: `【未开播】${ch.name}`,
        icon: cover,
        url: channelUrl,
      });
    }
  }
  return { channels, programmes };
}

app.get('/subscribe/yt/live.m3u', async (c) => {
  const base = getBaseUrl(c);
  return c.text(renderM3U(await buildYTM3UEntries(base), { 'x-tvg-url': `${base}/subscribe/yt/guide.xml` }));
});

app.get('/subscribe/yt/guide.xml', async (c) => {
  const { channels, programmes } = await buildYTGuide(getBaseUrl(c));
  c.header('content-type', 'application/xml; charset=utf-8');
  return c.body(renderXMLTV(channels, programmes));
});

async function channelIdParam(c: Context) {
  const input = decodeURIComponent(c.req.param('channel') || '').replace(/\.(jpg|jpeg|png|webp)$/i, '');
  try {
    return await resolveChannelId(input);
  }
  catch(e) {
    console.error(`Failed to resolve YouTube channel ${input}:`, e);
    return null;
  }
}

async function sendAvatar(c: Context, channelId: string) {
  const meta = (await getChannelMeta([channelId])).get(channelId);
  if(!meta?.avatar) {
    c.status(404);
    return c.text('Not Found');
  }
  const image = await fetchCachedImage(`yt:avatar:${channelId}`, meta.avatar, 72 * 3600, ytFetch);
  if(!image) {
    c.status(404);
    return c.text('Not Found');
  }
  return sendBinary(c, image);
}

app.get('/meta/live/yt/avatar/:channel', async (c) => {
  const channelId = await channelIdParam(c);
  if(!channelId) {
    c.status(404);
    return c.text('Not Found');
  }
  return sendAvatar(c, channelId);
});

// live / upcoming thumbnail, channel avatar when offline
app.get('/meta/live/yt/cover/:channel', async (c) => {
  const channelId = await channelIdParam(c);
  if(!channelId) {
    c.status(404);
    return c.text('Not Found');
  }
  const status = await getOneChannelStatus(channelId).catch(() => null);
  if(status?.videoId && status.status !== 'offline') {
    const image = await fetchCachedImage(`yt:cover:${status.videoId}`, status.thumbnail || videoThumbnail(status.videoId), 300, ytFetch);
    if(image) return sendBinary(c, image);
  }
  return sendAvatar(c, channelId);
});

export default app;
