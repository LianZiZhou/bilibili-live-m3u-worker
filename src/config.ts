import fs = require('fs');
import dotenv = require('dotenv');

dotenv.config();

export type YTSource = 'local' | 'dataapi' | 'holodex';
export type YTPlayback = 'passthrough' | 'mux';

export interface YTChannelConfig {
  // YouTube channel id (UC...) or handle (@xxx)
  id: string;
  name?: string;
  group?: string;
}

export interface AppConfig {
  serviceUrl: string;
  port: number;
  redisUrl: string;
  bilibili: {
    sessdata: string;
  };
  youtube: {
    source: YTSource;
    dataApiKey: string;
    holodexApiKey: string;
    channels: YTChannelConfig[];
    holodexOrgs: string[];
    // seconds to cache live status, 0 = use source default
    statusCacheSeconds: number;
    playback: YTPlayback;
    // max video height, 0 = best
    quality: number;
    // codecs allowed as video track in mux mode
    muxCodecs: string[];
    cookiesPath: string;
    // http(s)://, socks4://, socks5://, socks5h:// or empty for direct
    proxy: string;
    placeholderImage: string;
  };
}

export const defaultConfig: AppConfig = {
  serviceUrl: '',
  port: 10028,
  redisUrl: 'redis://localhost:6379',
  bilibili: {
    sessdata: '',
  },
  youtube: {
    source: 'local',
    dataApiKey: '',
    holodexApiKey: '',
    channels: [],
    holodexOrgs: [],
    statusCacheSeconds: 0,
    playback: 'passthrough',
    quality: 0,
    muxCodecs: ['avc1'],
    cookiesPath: './cookies.json',
    proxy: '',
    placeholderImage: '',
  },
};

const SOURCES: YTSource[] = ['local', 'dataapi', 'holodex'];
const PLAYBACKS: YTPlayback[] = ['passthrough', 'mux'];

export function parseQuality(value: unknown): number {
  if(value === undefined || value === null || value === '' || value === 'best') {
    return 0;
  }
  const n = parseInt(String(value).replace(/p$/i, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseChannelList(value: string): YTChannelConfig[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    // "UCxxxx:显示名" or "@handle:显示名"
    const idx = item.indexOf(':');
    if(idx > 0) {
      return { id: item.slice(0, idx), name: item.slice(idx + 1) };
    }
    return { id: item };
  });
}

function normalizeChannels(list: unknown): YTChannelConfig[] {
  if(!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => {
    if(typeof item === 'string') {
      return { id: item };
    }
    return item as YTChannelConfig;
  }).filter((item) => item && typeof item.id === 'string' && item.id.length > 0);
}

export function buildConfig(file: any, env: Record<string, string | undefined>): AppConfig {
  const yt = { ...defaultConfig.youtube, ...(file?.youtube || {}) };
  const config: AppConfig = {
    serviceUrl: file?.serviceUrl ?? defaultConfig.serviceUrl,
    port: Number(file?.port) || defaultConfig.port,
    redisUrl: file?.redisUrl || defaultConfig.redisUrl,
    bilibili: { ...defaultConfig.bilibili, ...(file?.bilibili || {}) },
    youtube: {
      ...yt,
      channels: normalizeChannels(yt.channels),
      holodexOrgs: Array.isArray(yt.holodexOrgs) ? yt.holodexOrgs : [],
      quality: parseQuality(yt.quality),
      muxCodecs: Array.isArray(yt.muxCodecs) && yt.muxCodecs.length > 0 ? yt.muxCodecs : defaultConfig.youtube.muxCodecs,
      statusCacheSeconds: Number(yt.statusCacheSeconds) || 0,
    },
  };

  // environment variables take precedence over the config file
  if(env.SERVICE_URL) config.serviceUrl = env.SERVICE_URL;
  if(env.PORT) config.port = Number(env.PORT) || config.port;
  if(env.REDIS_URL) config.redisUrl = env.REDIS_URL;
  if(env.BILI_SESSDATA) config.bilibili.sessdata = env.BILI_SESSDATA;
  if(env.YT_SOURCE) config.youtube.source = env.YT_SOURCE as YTSource;
  if(env.YT_DATA_API_KEY) config.youtube.dataApiKey = env.YT_DATA_API_KEY;
  if(env.HOLODEX_API_KEY) config.youtube.holodexApiKey = env.HOLODEX_API_KEY;
  if(env.YT_CHANNELS) config.youtube.channels = parseChannelList(env.YT_CHANNELS);
  if(env.HOLODEX_ORGS) config.youtube.holodexOrgs = env.HOLODEX_ORGS.split(',').map((s) => s.trim()).filter(Boolean);
  if(env.YT_PLAYBACK) config.youtube.playback = env.YT_PLAYBACK as YTPlayback;
  if(env.YT_QUALITY) config.youtube.quality = parseQuality(env.YT_QUALITY);
  if(env.YT_COOKIES_PATH) config.youtube.cookiesPath = env.YT_COOKIES_PATH;
  if(env.YT_PROXY) config.youtube.proxy = env.YT_PROXY;
  if(env.YT_PLACEHOLDER_IMAGE) config.youtube.placeholderImage = env.YT_PLACEHOLDER_IMAGE;

  if(!SOURCES.includes(config.youtube.source)) {
    console.warn(`Unknown youtube.source "${config.youtube.source}", fallback to local`);
    config.youtube.source = 'local';
  }
  if(!PLAYBACKS.includes(config.youtube.playback)) {
    console.warn(`Unknown youtube.playback "${config.youtube.playback}", fallback to passthrough`);
    config.youtube.playback = 'passthrough';
  }
  config.serviceUrl = config.serviceUrl.replace(/\/+$/, '');
  return config;
}

function loadConfigFile(path: string) {
  if(!fs.existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
  }
  catch(e) {
    console.error(`Failed to parse config file ${path}:`, e);
    return {};
  }
}

const config = buildConfig(loadConfigFile(process.env.CONFIG_PATH || './config.json'), process.env);

export default config;
