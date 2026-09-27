import { describe, expect, test } from 'bun:test';
import { extractJSONAfter, LocalProvider, parseChannelPage, parseLivePage } from '../src/providers/youtube/local';
import { DataApiProvider, parseVideosResponse } from '../src/providers/youtube/dataApi';
import { HolodexProvider, parseHolodexVideos } from '../src/providers/youtube/holodex';
import { pickBest } from '../src/providers/youtube/types';
import type { FetchLike } from '../src/module/proxy';

const CH = 'UCSJ4gkVC6NrvII8umztf0Ow';
const CH2 = 'UCBR8-60-B28hp2BmDPdntcQ';

function page(scripts: Record<string, unknown>, head = '') {
  const body = Object.entries(scripts).map(([name, value]) => `<script>var ${name} = ${JSON.stringify(value)};var meta = 1;</script>`).join('\n');
  return `<html><head>${head}</head><body>${body}</body></html>`;
}

const livePlayer = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: 'nI725iVsyoQ', title: 'lofi {live} "radio"', isLive: true, channelId: CH, author: 'Lofi Girl' },
  microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-09-23T16:47:51+00:00' } } },
};

const upcomingPlayer = {
  playabilityStatus: {
    status: 'LIVE_STREAM_OFFLINE',
    liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: '1790600000' } } } },
  },
  videoDetails: { videoId: 'upcoming123', title: 'Upcoming', isUpcoming: true, channelId: CH, author: 'Lofi Girl' },
};

const channelData = {
  metadata: { channelMetadataRenderer: { title: 'Lofi & Girl', externalId: CH, avatar: { thumbnails: [{ url: 'https://yt3.example/avatar' }] } } },
};

describe('local provider parsing', () => {
  test('extractJSONAfter handles braces inside strings', () => {
    const html = page({ ytInitialPlayerResponse: livePlayer });
    expect(extractJSONAfter(html, 'var ytInitialPlayerResponse = ').videoDetails.title).toBe('lofi {live} "radio"');
    expect(extractJSONAfter(html, 'var missing = ')).toBeNull();
  });

  test('live page', () => {
    const live = parseLivePage(CH, page({ ytInitialPlayerResponse: livePlayer }));
    expect(live).toMatchObject({
      channelId: CH,
      status: 'live',
      videoId: 'nI725iVsyoQ',
      title: 'lofi {live} "radio"',
      startTime: Date.parse('2026-09-23T16:47:51+00:00'),
      channelName: 'Lofi Girl',
    });
  });

  test('upcoming page', () => {
    const live = parseLivePage(CH, page({ ytInitialPlayerResponse: upcomingPlayer }));
    expect(live).toMatchObject({ status: 'upcoming', videoId: 'upcoming123', startTime: 1790600000 * 1000 });
  });

  test('player response withheld (bot check), falls back to ytInitialData', () => {
    const html = page({
      ytInitialPlayerResponse: { playabilityStatus: { status: 'LOGIN_REQUIRED' } },
      ytInitialData: {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'nI725iVsyoQ' } },
        contents: { twoColumnWatchNextResults: { results: { results: { contents: [
          { videoPrimaryInfoRenderer: { title: { runs: [{ text: 'lofi ' }, { text: 'radio' }] }, viewCount: { videoViewCountRenderer: { isLive: true } } } },
          { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: { runs: [{ text: 'Lofi Girl' }] } } } } },
        ] } } } },
      },
    }, '<link rel="canonical" href="undefined">');
    expect(parseLivePage(CH, html)).toMatchObject({ status: 'live', videoId: 'nI725iVsyoQ', title: 'lofi radio', channelName: 'Lofi Girl' });
  });

  test('channel page without stream is offline', () => {
    const html = page({ ytInitialData: channelData }, `<link rel="canonical" href="https://www.youtube.com/channel/${CH}">`);
    expect(parseLivePage(CH, html)).toEqual({ channelId: CH, status: 'offline', channelName: 'Lofi & Girl', channelAvatar: 'https://yt3.example/avatar' });
  });

  test('channel page meta', () => {
    expect(parseChannelPage(page({ ytInitialData: channelData }))).toEqual({ channelId: CH, name: 'Lofi & Girl', avatar: 'https://yt3.example/avatar' });
    const metaOnly = `<link rel="canonical" href="https://www.youtube.com/channel/${CH}"><meta property="og:title" content="A &amp; B"><meta property="og:image" content="https://img">`;
    expect(parseChannelPage(metaOnly)).toEqual({ channelId: CH, name: 'A & B', avatar: 'https://img' });
    expect(parseChannelPage('')).toBeNull();
  });

  test('LocalProvider requests', async () => {
    const urls: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = input.toString();
      urls.push(url);
      if(url.endsWith('/@missing')) return new Response('', { status: 404 });
      if(url.endsWith('/live')) return new Response(page({ ytInitialPlayerResponse: livePlayer }));
      return new Response(page({ ytInitialData: channelData }));
    };
    const provider = new LocalProvider({ fetch: fetcher });
    const resolved = await provider.resolveChannelIds(['@lofi', CH, '@missing']);
    expect(resolved.get('@lofi')).toBe(CH);
    expect(resolved.get(CH)).toBe(CH);
    expect(resolved.has('@missing')).toBe(false);
    const status = await provider.getStatus([CH]);
    expect(status.get(CH)!.status).toBe('live');
    expect(urls).toContain(`https://www.youtube.com/channel/${CH}/live`);
    expect(urls).toContain('https://www.youtube.com/@lofi');
  });
});

describe('pickBest', () => {
  test('prefers live, then nearest upcoming', () => {
    expect(pickBest([
      { channelId: 'a', status: 'upcoming', startTime: 300 },
      { channelId: 'a', status: 'upcoming', startTime: 200 },
    ])!.startTime).toBe(200);
    expect(pickBest([
      { channelId: 'a', status: 'upcoming', startTime: 100 },
      { channelId: 'a', status: 'live', videoId: 'x' },
    ])!.videoId).toBe('x');
    expect(pickBest([])).toBeUndefined();
  });
});

describe('dataapi provider', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');

  test('parseVideosResponse', () => {
    const result = parseVideosResponse([
      { id: 'live1', snippet: { channelId: CH, title: 'L', liveBroadcastContent: 'live', channelTitle: 'C' }, liveStreamingDetails: { actualStartTime: '2026-09-26T23:00:00Z' } },
      { id: 'up1', snippet: { channelId: CH, title: 'U', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: '2026-09-27T10:00:00Z' } },
      { id: 'frame', snippet: { channelId: CH, title: 'Free chat', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: '2027-01-01T00:00:00Z' } },
      { id: 'vod', snippet: { channelId: CH, title: 'V', liveBroadcastContent: 'none' } },
    ], now);
    expect(result.map((r) => r.videoId)).toEqual(['live1', 'up1']);
    expect(result[0]).toMatchObject({ status: 'live', startTime: Date.parse('2026-09-26T23:00:00Z'), channelName: 'C' });
  });

  test('requires api key', () => {
    expect(() => new DataApiProvider({ fetch, apiKey: '' })).toThrow();
  });

  test('getStatus queries uploads playlists and videos', async () => {
    const urls: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = new URL(input.toString());
      urls.push(url);
      if(url.pathname.endsWith('/playlistItems')) {
        if(url.searchParams.get('playlistId') === 'UU' + CH2.slice(2)) {
          return Response.json({ error: { message: 'not found' } }, { status: 404 });
        }
        return Response.json({ items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] });
      }
      if(url.pathname.endsWith('/videos')) {
        return Response.json({ items: [
          { id: 'v1', snippet: { channelId: CH, title: 'Now', liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: new Date().toISOString() } },
          { id: 'v2', snippet: { channelId: CH, liveBroadcastContent: 'none' } },
        ] });
      }
      return new Response('', { status: 500 });
    };
    const provider = new DataApiProvider({ fetch: fetcher, apiKey: 'KEY' });
    const status = await provider.getStatus([CH, CH2]);
    expect(status.get(CH)).toMatchObject({ status: 'live', videoId: 'v1', title: 'Now' });
    expect(status.get(CH2)).toEqual({ channelId: CH2, status: 'offline' });
    expect(urls.every((u) => u.searchParams.get('key') === 'KEY')).toBe(true);
    expect(urls.find((u) => u.pathname.endsWith('/playlistItems'))!.searchParams.get('playlistId')).toBe('UU' + CH.slice(2));
    expect(urls.find((u) => u.pathname.endsWith('/videos'))!.searchParams.get('id')).toBe('v1,v2');
  });

  test('getChannelMeta', async () => {
    const provider = new DataApiProvider({
      apiKey: 'KEY',
      fetch: async () => Response.json({ items: [{ id: CH, snippet: { title: 'Lofi', thumbnails: { high: { url: 'https://a' } } } }] }),
    });
    expect((await provider.getChannelMeta([CH])).get(CH)).toEqual({ channelId: CH, name: 'Lofi', avatar: 'https://a' });
  });
});

describe('holodex provider', () => {
  const videos = [
    { id: 'hl1', title: 'Live!', type: 'stream', topic_id: 'singing', status: 'live', start_scheduled: '2026-09-27T10:00:00.000Z', start_actual: '2026-09-27T10:01:00.000Z', channel: { id: CH, name: 'Suisei', photo: 'https://photo' } },
    { id: 'mem', title: 'Members', type: 'stream', topic_id: 'membersonly', status: 'live', channel: { id: CH2, name: 'X' } },
    { id: 'hu1', title: 'Soon', type: 'stream', status: 'upcoming', start_scheduled: '2026-09-28T10:00:00.000Z', channel: { id: CH2, name: 'X', photo: 'https://p2' } },
    { id: 'clip', title: 'Clip', type: 'clip', status: 'past', channel: { id: CH, name: 'Suisei' } },
  ];

  test('parseHolodexVideos', () => {
    const result = parseHolodexVideos(videos);
    expect(result.map((r) => r.videoId)).toEqual(['hl1', 'hu1']);
    expect(result[0]).toMatchObject({ status: 'live', startTime: Date.parse('2026-09-27T10:01:00.000Z'), channelName: 'Suisei', channelAvatar: 'https://photo' });
    expect(result[1]).toMatchObject({ status: 'upcoming', startTime: Date.parse('2026-09-28T10:00:00.000Z') });
    expect(parseHolodexVideos(null as any)).toEqual([]);
  });

  test('requests carry api key', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetcher: FetchLike = async (input, init) => {
      seen.push({ url: input.toString(), key: new Headers(init?.headers).get('X-APIKEY') });
      const url = new URL(input.toString());
      if(url.pathname.endsWith('/users/live')) return Response.json(videos);
      if(url.pathname.endsWith('/live')) return Response.json(videos);
      return Response.json({ id: CH, name: 'Suisei', photo: 'https://photo' });
    };
    const provider = new HolodexProvider({ fetch: fetcher, apiKey: 'HKEY' });
    const status = await provider.getStatus([CH, CH2, 'UCcccccccccccccccccccccc']);
    expect(status.get(CH)!.videoId).toBe('hl1');
    expect(status.get(CH2)!.videoId).toBe('hu1');
    expect(status.get('UCcccccccccccccccccccccc')!.status).toBe('offline');
    expect(new URL(seen[0].url).searchParams.get('channels')).toBe(`${CH},${CH2},UCcccccccccccccccccccccc`);
    const org = await provider.getOrgLive(['Hololive']);
    expect(org.map((o) => o.videoId).sort()).toEqual(['hl1', 'hu1']);
    expect(new URL(seen[1].url).searchParams.get('org')).toBe('Hololive');
    expect((await provider.getChannelMeta([CH])).get(CH)).toEqual({ channelId: CH, name: 'Suisei', avatar: 'https://photo' });
    expect(seen.every((s) => s.key === 'HKEY')).toBe(true);
  });
});
