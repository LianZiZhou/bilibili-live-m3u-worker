import config, { type YTPlayback } from '../../config';
import redis from '../redis';
import { ytFetch } from '../proxy';
import { singleFlight } from '../../utils/singleflight';
import { buildMediaPlaylist, parseMediaPlaylist, rewriteMediaPlaylist, selectVariant } from '../../utils/hls';
import { getCachedBinary, setCachedBinary, type CachedBinary } from '../../utils/binaryCache';
import { ffmpegAvailable, muxToTS } from '../../utils/ffmpeg';
import { getStreamInfo, invalidateStreamInfo, type YTAdaptiveFormat, type YTStreamInfo, type YTVariant } from './stream';

// segment url mappings live a bit longer than the playlist window
const SEGMENT_URL_TTL = 900;
// segment payload cache, shared between clients watching the same stream
const SEGMENT_CACHE_TTL = 60;

// Offset added to live media sequence numbers on channel playlists, so they are
// always greater than the wall-clock based placeholder sequence numbers
export const LIVE_SEQ_OFFSET = 1_000_000_000;

const TS_TYPE = 'video/mp2t';

export class StreamUnavailableError extends Error {}

function pickVariant(info: YTStreamInfo, quality: number): YTVariant | undefined {
  return selectVariant(info.variants, quality);
}

function codecAllowed(codecs: string, allowed: string[]) {
  const c = codecs.toLowerCase();
  return allowed.some((a) => {
    const prefix = a.toLowerCase();
    if(prefix === 'vp9') return c.startsWith('vp9') || c.startsWith('vp09');
    if(prefix === 'av1') return c.startsWith('av01');
    if(prefix === 'h264') return c.startsWith('avc1');
    return c.startsWith(prefix);
  });
}

export function pickMuxFormats(info: YTStreamInfo, quality: number, allowedCodecs: string[]) {
  const videos = info.videoFormats.filter((f) => codecAllowed(f.codecs, allowedCodecs));
  const video = selectVariant(videos, quality);
  const audios = [...info.audioFormats].sort((a, b) => {
    // prefer AAC for MPEG-TS compatibility, then bitrate
    const aac = Number(b.codecs.startsWith('mp4a')) - Number(a.codecs.startsWith('mp4a'));
    return aac || (b.bandwidth - a.bandwidth);
  });
  return { video, audio: audios[0] as YTAdaptiveFormat | undefined };
}

async function fetchVariantPlaylist(info: YTStreamInfo, variant: YTVariant): Promise<string> {
  return singleFlight(`yt:variant:${info.videoId}:${variant.itag}`, async () => {
    const response = await ytFetch(variant.uri);
    if(response.status !== 200) {
      const error = new StreamUnavailableError(`Failed to fetch YouTube variant playlist, status: ${response.status}`);
      (error as any).status = response.status;
      throw error;
    }
    return await response.text();
  });
}

// retry once with fresh stream info when signed urls have expired
async function withFreshInfo<T>(videoId: string, fn: (info: YTStreamInfo) => Promise<T>): Promise<T | null> {
  for(let attempt = 0; attempt < 2; attempt++) {
    const info = await getStreamInfo(videoId);
    if(!info.playable) return null;
    try {
      return await fn(info);
    }
    catch(e: any) {
      if(attempt === 0 && [403, 404, 410].includes(e?.status)) {
        await invalidateStreamInfo(videoId);
        continue;
      }
      throw e;
    }
  }
  return null;
}

async function buildPassthroughPlaylist(base: string, videoId: string, quality: number, seqOffset: number) {
  return withFreshInfo(videoId, async (info) => {
    const variant = pickVariant(info, quality);
    if(!variant) return null;
    const text = await fetchVariantPlaylist(info, variant);
    const playlist = parseMediaPlaylist(text);
    const pipeline = redis.pipeline();
    for(const segment of playlist.segments) {
      pipeline.set(`yt:seg:${videoId}:${variant.itag}:${segment.seq}`, new URL(segment.uri, variant.uri).toString(), 'EX', SEGMENT_URL_TTL);
    }
    await pipeline.exec();
    return rewriteMediaPlaylist(text, (segment) => `${base}/play/live/yt/${videoId}/${variant.itag}/${segment.seq}.ts`, seqOffset);
  });
}

async function buildMuxPlaylist(base: string, videoId: string, quality: number, seqOffset: number) {
  return withFreshInfo(videoId, async (info) => {
    const { video, audio } = pickMuxFormats(info, quality, config.youtube.muxCodecs);
    if(!video || !audio) {
      // nothing to mux, use the HLS stream as is
      return null;
    }
    // the best HLS variant provides sequence numbers, durations and a fallback per segment
    const fallbackVariant = pickVariant(info, 0);
    let segments: { seq: number; duration: number; fallback?: string }[] = [];
    let targetDuration = video.targetDurationSec || 5;
    if(fallbackVariant) {
      const playlist = parseMediaPlaylist(await fetchVariantPlaylist(info, fallbackVariant));
      targetDuration = playlist.targetDuration || targetDuration;
      segments = playlist.segments.map((s) => ({ seq: s.seq, duration: s.duration, fallback: new URL(s.uri, fallbackVariant.uri).toString() }));
    }
    else {
      // no HLS manifest, derive the live head from the DASH audio stream
      const head = await ytFetch(audio.url, { method: 'HEAD' });
      const headSeq = Number(head.headers.get('x-head-seqnum'));
      if(!Number.isFinite(headSeq) || headSeq <= 0) {
        const error = new StreamUnavailableError(`Failed to read YouTube live head sequence, status: ${head.status}`);
        (error as any).status = head.status;
        throw error;
      }
      for(let seq = Math.max(0, headSeq - 3); seq <= headSeq; seq++) {
        segments.push({ seq, duration: targetDuration });
      }
    }
    const pipeline = redis.pipeline();
    pipeline.set(`yt:mux:${videoId}`, JSON.stringify({ video: video.url, audio: audio.url }), 'EX', SEGMENT_URL_TTL);
    for(const segment of segments) {
      if(segment.fallback) {
        pipeline.set(`yt:mux:${videoId}:fallback:${segment.seq}`, segment.fallback, 'EX', SEGMENT_URL_TTL);
      }
    }
    await pipeline.exec();
    return buildMediaPlaylist({
      targetDuration,
      mediaSequence: (segments[0]?.seq || 0) + seqOffset,
      segments: segments.map((s) => ({ uri: `${base}/play/live/yt/${videoId}/mux/${s.seq}.ts`, duration: s.duration })),
    });
  });
}

/**
 * Build the media playlist of a live video.
 * Returns null when the video is not live / not playable.
 */
export async function buildLivePlaylist(base: string, videoId: string, opts: { mode?: YTPlayback; quality?: number; seqOffset?: number } = {}) {
  const mode = opts.mode || config.youtube.playback;
  const quality = opts.quality ?? config.youtube.quality;
  const seqOffset = opts.seqOffset || 0;
  if(mode === 'mux') {
    if(await ffmpegAvailable()) {
      const playlist = await buildMuxPlaylist(base, videoId, quality, seqOffset);
      if(playlist) return playlist;
    }
    else {
      console.warn('ffmpeg is not available, mux mode falls back to passthrough');
    }
  }
  return await buildPassthroughPlaylist(base, videoId, quality, seqOffset);
}

async function fetchUpstream(url: string): Promise<Buffer | null> {
  const response = await ytFetch(url);
  if(response.status !== 200) {
    console.error(`YouTube segment upstream returned ${response.status}`);
    return null;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function cachedSegment(key: string, produce: () => Promise<CachedBinary | null>): Promise<CachedBinary | null> {
  const cached = await getCachedBinary(key);
  if(cached) return cached;
  return singleFlight(key, async () => {
    const value = await produce();
    if(value) await setCachedBinary(key, value, SEGMENT_CACHE_TTL);
    return value;
  });
}

export async function getPassthroughSegment(videoId: string, itag: string, seq: number) {
  return cachedSegment(`yt:live:cache:${videoId}:${itag}:${seq}`, async () => {
    const url = await redis.get(`yt:seg:${videoId}:${itag}:${seq}`);
    if(!url) return null;
    const body = await fetchUpstream(url);
    return body ? { body, type: TS_TYPE } : null;
  });
}

export async function getMuxSegment(videoId: string, seq: number) {
  return cachedSegment(`yt:live:cache:${videoId}:mux:${seq}`, async () => {
    const [formats, fallback] = await Promise.all([
      redis.get(`yt:mux:${videoId}`),
      redis.get(`yt:mux:${videoId}:fallback:${seq}`),
    ]);
    if(formats) {
      const { video, audio } = JSON.parse(formats) as { video: string; audio: string };
      try {
        const [v, a] = await Promise.all([
          fetchUpstream(`${video}&sq=${seq}`),
          fetchUpstream(`${audio}&sq=${seq}`),
        ]);
        if(v && a) {
          return { body: await muxToTS(v, a), type: TS_TYPE };
        }
      }
      catch(e) {
        console.error(`Failed to mux YouTube segment ${videoId}/${seq}:`, e);
      }
    }
    // DASH chunks unavailable or mux failed, serve the muxed HLS segment instead
    if(fallback) {
      const body = await fetchUpstream(fallback);
      if(body) return { body, type: TS_TYPE };
    }
    return null;
  });
}
