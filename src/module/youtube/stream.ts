import fs = require('fs');
import { Innertube, Log } from 'youtubei.js';
import config from '../../config';
import redis from '../redis';
import { ytFetch } from '../proxy';
import { singleFlight } from '../../utils/singleflight';
import { parseMasterPlaylist, type HLSVariant } from '../../utils/hls';

Log.setLevel(Log.Level.ERROR);

export interface YTAdaptiveFormat {
  itag: number;
  url: string;
  mimeType: string;
  codecs: string;
  width: number;
  height: number;
  fps: number;
  bandwidth: number;
  targetDurationSec: number;
}

export interface YTVariant extends HLSVariant {
  itag: string;
}

export interface YTStreamInfo {
  videoId: string;
  playable: boolean;
  reason?: string;
  hlsManifestUrl?: string;
  variants: YTVariant[];
  videoFormats: YTAdaptiveFormat[];
  audioFormats: YTAdaptiveFormat[];
  expiresAt: number;
}

// clients that return a live HLS manifest without PO tokens
const CLIENTS = ['ANDROID_VR', 'IOS'] as const;

const NEGATIVE_TTL = 30;
const MAX_TTL = 3 * 3600;

export function loadCookie(cookiesPath: string): string | undefined {
  if(!cookiesPath || !fs.existsSync(cookiesPath)) {
    return undefined;
  }
  const text = fs.readFileSync(cookiesPath, 'utf-8').trim();
  if(!text) return undefined;
  // browser extension export: [{ name, value, domain, ... }]
  if(text.startsWith('[')) {
    const list = JSON.parse(text) as { name: string; value: string; domain?: string }[];
    return list
      .filter((c) => !c.domain || /youtube\.com$/.test(c.domain.replace(/^\./, '')) || c.domain.includes('youtube'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
  // Netscape cookies.txt
  if(text.includes('\t')) {
    return text.split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('youtube'))
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length >= 7)
      .map((cols) => `${cols[5]}=${cols[6]}`)
      .join('; ');
  }
  // raw "a=b; c=d" header value
  return text;
}

let innertube: Promise<Innertube> | null = null;

function getInnertube(): Promise<Innertube> {
  if(!innertube) {
    const cookie = loadCookie(config.youtube.cookiesPath);
    if(cookie) console.log(`YouTube cookies loaded from ${config.youtube.cookiesPath}`);
    innertube = Innertube.create({
      retrieve_player: false,
      fetch: ytFetch as any,
      cookie,
    }).catch((e) => {
      innertube = null;
      throw e;
    });
  }
  return innertube;
}

function codecsOf(mimeType: string) {
  return mimeType.match(/codecs="([^"]*)"/)?.[1] || '';
}

async function fetchStreamInfo(videoId: string): Promise<YTStreamInfo> {
  const yt = await getInnertube();
  let lastReason = 'unknown';
  for(const client of CLIENTS) {
    let info;
    try {
      info = await yt.getBasicInfo(videoId, { client: client as any });
    }
    catch(e: any) {
      lastReason = `${client}: ${e?.message || e}`;
      continue;
    }
    const playability = info.playability_status;
    const streaming = info.streaming_data;
    if(playability?.status !== 'OK' || !streaming) {
      lastReason = `${client}: ${playability?.status} ${playability?.reason || ''}`.trim();
      continue;
    }
    if(!streaming.hls_manifest_url && !info.basic_info.is_live) {
      // not a live stream (ended / VOD)
      return { videoId, playable: false, reason: 'not live', variants: [], videoFormats: [], audioFormats: [], expiresAt: 0 };
    }
    const adaptive: YTAdaptiveFormat[] = (streaming.adaptive_formats || [])
      .filter((f: any) => f.url)
      .map((f: any) => ({
        itag: f.itag,
        url: f.url,
        mimeType: f.mime_type,
        codecs: codecsOf(f.mime_type),
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        bandwidth: f.bitrate || 0,
        targetDurationSec: f.target_duration_sec || 0,
      }));
    let variants: YTVariant[] = [];
    if(streaming.hls_manifest_url) {
      const response = await ytFetch(streaming.hls_manifest_url);
      if(response.status === 200) {
        variants = parseMasterPlaylist(await response.text()).map((v, i) => ({
          ...v,
          itag: v.uri.match(/\/itag\/(\d+)\//)?.[1] || `v${i}`,
        }));
      }
    }
    if(variants.length === 0 && adaptive.length === 0) {
      lastReason = `${client}: no stream formats`;
      continue;
    }
    return {
      videoId,
      playable: true,
      hlsManifestUrl: streaming.hls_manifest_url,
      variants,
      videoFormats: adaptive.filter((f) => f.mimeType.startsWith('video/')),
      audioFormats: adaptive.filter((f) => f.mimeType.startsWith('audio/')),
      expiresAt: streaming.expires ? new Date(streaming.expires).getTime() : Date.now() + 3600 * 1000,
    };
  }
  return { videoId, playable: false, reason: lastReason, variants: [], videoFormats: [], audioFormats: [], expiresAt: 0 };
}

export async function getStreamInfo(videoId: string): Promise<YTStreamInfo> {
  const key = `yt:stream:${videoId}`;
  const cached = await redis.get(key);
  if(cached) {
    return JSON.parse(cached);
  }
  return singleFlight(key, async () => {
    const info = await fetchStreamInfo(videoId);
    // refresh 10 minutes before the signed urls expire
    const ttl = info.playable
      ? Math.max(60, Math.min(MAX_TTL, Math.floor((info.expiresAt - Date.now()) / 1000) - 600))
      : NEGATIVE_TTL;
    if(!info.playable) {
      console.log(`YouTube ${videoId} not playable: ${info.reason}`);
    }
    await redis.set(key, JSON.stringify(info), 'EX', ttl);
    return info;
  });
}

export async function invalidateStreamInfo(videoId: string) {
  await redis.del(`yt:stream:${videoId}`);
}
