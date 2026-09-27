import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net = require('net');
import { ffmpegAvailable, runFFmpeg } from '../src/utils/ffmpeg';

// Integration tests: a local mock of googlevideo, stream info seeded into redis,
// requests go through the real Hono app.

async function redisReachable() {
  const url = new URL(process.env.REDIS_URL!);
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(Number(url.port) || 6379, url.hostname, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

const hasRedis = await redisReachable();
const hasFFmpeg = await ffmpegAvailable();

if(!hasRedis) {
  console.warn('redis is not reachable, skipping playback integration tests');
}

const CH_LIVE = 'UCtesttesttesttesttest01';
const CH_OFF = 'UCtesttesttesttesttest02';
const VIDEO = 'vidPASS0001';
const VIDEO_BROKEN_DASH = 'vidBROKEN01';
const VIDEO_DEAD = 'vidDEAD0001';

describe.skipIf(!hasRedis)('youtube playback', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let app: { fetch: (req: Request) => Response | Promise<Response> };
  let redis: typeof import('../src/module/redis').default;
  const hits: Record<string, number> = {};
  let segmentTS: Buffer = Buffer.from([0x47, 1, 2, 3]);
  let videoChunk: Buffer = Buffer.alloc(0);
  let audioChunk: Buffer = Buffer.alloc(0);

  const hit = (key: string) => {
    hits[key] = (hits[key] || 0) + 1;
  };

  const request = (path: string) => app.fetch(new Request(`http://test.local${path}`));

  beforeAll(async () => {
    if(hasFFmpeg) {
      segmentTS = await runFFmpeg(['-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
        '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']);
      const frag = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
      videoChunk = await runFFmpeg(['-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25', '-t', '1', '-an', '-c:v', 'libx264', ...frag]);
      audioChunk = await runFFmpeg(['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '1', '-vn', '-c:a', 'aac', ...frag]);
    }

    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const base = `http://127.0.0.1:${upstream.port}`;
        const variant = url.pathname.match(/^\/hls\/(\d+)\/index\.m3u8$/);
        if(variant) {
          hit(`variant:${variant[1]}`);
          const itag = variant[1];
          return new Response([
            '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:500',
            ...[500, 501, 502].flatMap((sq) => ['#EXTINF:1.0,', `${base}/videoplayback/id/x.1/itag/${itag}/sq/${sq}/file/seg.ts`]),
          ].join('\n') + '\n');
        }
        const seg = url.pathname.match(/\/itag\/(\d+)\/sq\/(\d+)\//);
        if(seg) {
          hit(`seg:${seg[1]}:${seg[2]}`);
          return new Response(new Uint8Array(segmentTS), { headers: { 'content-type': 'video/mp2t' } });
        }
        if(url.pathname === '/dash/video') {
          hit(`dash:video:${url.searchParams.get('sq')}`);
          return new Response(new Uint8Array(videoChunk));
        }
        if(url.pathname === '/dash/audio') {
          hit(`dash:audio:${url.searchParams.get('sq')}`);
          return new Response(new Uint8Array(audioChunk));
        }
        return new Response('forbidden', { status: 403 });
      },
    });

    redis = (await import('../src/module/redis')).default;
    await redis.flushdb();

    const base = `http://127.0.0.1:${upstream.port}`;
    const streamInfo = (videoId: string, videoUrl: string) => ({
      videoId,
      playable: true,
      hlsManifestUrl: `${base}/master.m3u8`,
      variants: [
        { uri: `${base}/hls/95/index.m3u8`, bandwidth: 2969452, width: 1280, height: 720, fps: 30, codecs: 'mp4a.40.2,avc1.4D401F', itag: '95' },
        { uri: `${base}/hls/96/index.m3u8`, bandwidth: 5420722, width: 1920, height: 1080, fps: 30, codecs: 'mp4a.40.2,avc1.640028', itag: '96' },
      ],
      videoFormats: [
        { itag: 137, url: videoUrl, mimeType: 'video/mp4; codecs="avc1.640028"', codecs: 'avc1.640028', width: 1920, height: 1080, fps: 30, bandwidth: 4000000, targetDurationSec: 1 },
        { itag: 248, url: `${base}/dash/vp9`, mimeType: 'video/webm; codecs="vp9"', codecs: 'vp9', width: 1920, height: 1080, fps: 30, bandwidth: 3000000, targetDurationSec: 1 },
      ],
      audioFormats: [
        { itag: 140, url: `${base}/dash/audio?id=x`, mimeType: 'audio/mp4; codecs="mp4a.40.2"', codecs: 'mp4a.40.2', width: 0, height: 0, fps: 0, bandwidth: 128000, targetDurationSec: 1 },
      ],
      expiresAt: Date.now() + 6 * 3600 * 1000,
    });
    await redis.set(`yt:stream:${VIDEO}`, JSON.stringify(streamInfo(VIDEO, `${base}/dash/video?id=x`)), 'EX', 600);
    await redis.set(`yt:stream:${VIDEO_BROKEN_DASH}`, JSON.stringify(streamInfo(VIDEO_BROKEN_DASH, `${base}/dash/forbidden?id=x`)), 'EX', 600);
    await redis.set(`yt:stream:${VIDEO_DEAD}`, JSON.stringify({ videoId: VIDEO_DEAD, playable: false, reason: 'ended', variants: [], videoFormats: [], audioFormats: [], expiresAt: 0 }), 'EX', 600);
    await redis.set(`yt:status:${CH_LIVE}`, JSON.stringify({ channelId: CH_LIVE, status: 'live', videoId: VIDEO, title: 'Live & <loud>', startTime: Date.now() - 60000 }), 'EX', 600);
    await redis.set(`yt:status:${CH_OFF}`, JSON.stringify({ channelId: CH_OFF, status: 'upcoming', videoId: 'upcoming001', title: 'Soon', startTime: Date.now() + 3600000 }), 'EX', 600);
    await redis.set(`yt:meta:${CH_LIVE}`, JSON.stringify({ channelId: CH_LIVE, name: 'Meta name', avatar: `${base}/forbidden-avatar` }), 'EX', 600);
    await redis.set(`yt:meta:${CH_OFF}`, JSON.stringify({ channelId: CH_OFF, name: 'Offline Channel', avatar: `${base}/forbidden-avatar` }), 'EX', 600);

    app = (await import('../src/index')).default;
  });

  afterAll(async () => {
    upstream?.stop(true);
    await redis?.flushdb();
  });

  test('passthrough playlist rewrites segment urls', async () => {
    const response = await request(`/play/live/yt/${VIDEO}/index.m3u8`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await response.text();
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:500');
    const uris = text.split('\n').filter((l) => l.startsWith('http'));
    expect(uris).toEqual([500, 501, 502].map((sq) => `http://test.local/play/live/yt/${VIDEO}/96/${sq}.ts`));
  });

  test('quality selects a lower variant', async () => {
    const text = await (await request(`/play/live/yt/${VIDEO}/index.m3u8?quality=720`)).text();
    expect(text).toContain(`/play/live/yt/${VIDEO}/95/500.ts`);
  });

  test('segments are proxied, cached and coalesced', async () => {
    await request(`/play/live/yt/${VIDEO}/index.m3u8`);
    const responses = await Promise.all([1, 2, 3].map(() => request(`/play/live/yt/${VIDEO}/96/501.ts`)));
    for(const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('video/mp2t');
      expect(Buffer.from(await response.arrayBuffer()).equals(segmentTS)).toBe(true);
    }
    expect(hits['seg:96:501']).toBe(1);
    await request(`/play/live/yt/${VIDEO}/96/501.ts`);
    expect(hits['seg:96:501']).toBe(1);
  });

  test('unknown segment is 404', async () => {
    expect((await request(`/play/live/yt/${VIDEO}/96/999.ts`)).status).toBe(404);
  });

  test('live channel playlist shifts media sequence', async () => {
    const text = await (await request(`/play/live/yt/channel/${CH_LIVE}/index.m3u8`)).text();
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:1000000500');
    expect(text).toContain(`/play/live/yt/${VIDEO}/96/500.ts`);
  });

  test('offline channel and dead video get the placeholder', async () => {
    for(const path of [`/play/live/yt/channel/${CH_OFF}/index.m3u8`, `/play/live/yt/${VIDEO_DEAD}/index.m3u8`]) {
      const text = await (await request(path)).text();
      expect(text).toContain('#EXT-X-DISCONTINUITY');
      const uri = text.split('\n').find((l) => l.startsWith('http'))!;
      expect(uri).toMatch(/^http:\/\/test\.local\/play\/live\/yt\/offline\/\d+\.ts$/);
      // placeholder sequence numbers stay below the shifted live ones
      expect(Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)![1])).toBeLessThan(1_000_000_000);
    }
    const segment = await request('/play/live/yt/offline/1.ts');
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    const body = Buffer.from(await segment.arrayBuffer());
    expect(body[0]).toBe(0x47);
  });

  test('unknown channel is 404', async () => {
    expect((await request('/play/live/yt/channel/not-a-channel/index.m3u8')).status).toBe(404);
  });

  test.skipIf(!hasFFmpeg)('mux mode muxes DASH video and audio', async () => {
    const text = await (await request(`/play/live/yt/${VIDEO}/index.m3u8?mode=mux`)).text();
    const uris = text.split('\n').filter((l) => l.startsWith('http'));
    expect(uris).toEqual([500, 501, 502].map((sq) => `http://test.local/play/live/yt/${VIDEO}/mux/${sq}.ts`));
    const response = await request(`/play/live/yt/${VIDEO}/mux/502.ts`);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body[0]).toBe(0x47);
    expect(hits['dash:video:502']).toBe(1);
    expect(hits['dash:audio:502']).toBe(1);
    // the muxed segment must contain both an H.264 and an AAC stream
    const probe = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '-i', 'pipe:0'], { stdin: body });
    // (ffprobe lists MPEG-TS streams once per program and once globally)
    const codecs = new Set(probe.stdout.toString().split('\n').map((l) => l.trim()).filter(Boolean));
    expect([...codecs].sort()).toEqual(['aac', 'h264']);
  });

  test.skipIf(!hasFFmpeg)('mux mode falls back to the HLS segment when DASH is unavailable', async () => {
    await request(`/play/live/yt/${VIDEO_BROKEN_DASH}/index.m3u8?mode=mux`);
    const response = await request(`/play/live/yt/${VIDEO_BROKEN_DASH}/mux/500.ts`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(segmentTS)).toBe(true);
  });

  test('youtube subscription and guide', async () => {
    const m3u = await (await request('/subscribe/yt/live.m3u')).text();
    expect(m3u.startsWith('#EXTM3U x-tvg-url="http://test.local/subscribe/yt/guide.xml"')).toBe(true);
    // configured name wins over the fetched name
    expect(m3u).toContain(`tvg-id="yt-${CH_LIVE}" tvg-name="测试频道"`);
    expect(m3u).toContain(`http://test.local/play/live/yt/channel/${CH_LIVE}/index.m3u8`);
    expect(m3u).toContain(`tvg-name="Offline Channel"`);

    const xml = await (await request('/subscribe/yt/guide.xml')).text();
    expect(xml).toContain('<title lang="zh">Live &amp; &lt;loud&gt;</title>');
    expect(xml).toMatch(/【预定 \d\d-\d\d \d\d:\d\d】Soon/);
  });
});
