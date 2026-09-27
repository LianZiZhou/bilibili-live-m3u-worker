import { describe, expect, test } from 'bun:test';
import { buildConfig, parseChannelList, parseQuality } from '../src/config';

describe('config', () => {
  test('defaults', () => {
    const config = buildConfig({}, {});
    expect(config.port).toBe(10028);
    expect(config.youtube.source).toBe('local');
    expect(config.youtube.playback).toBe('passthrough');
    expect(config.youtube.quality).toBe(0);
    expect(config.youtube.muxCodecs).toEqual(['avc1']);
  });

  test('file values', () => {
    const config = buildConfig({
      serviceUrl: 'https://tv.example.com/',
      youtube: {
        source: 'holodex',
        holodexApiKey: 'k',
        channels: ['UCaaaaaaaaaaaaaaaaaaaaaa', { id: '@handle', name: 'N', group: 'G' }, { name: 'missing id' }],
        playback: 'mux',
        quality: '720p',
        proxy: 'socks5://127.0.0.1:1080',
      },
    }, {});
    expect(config.serviceUrl).toBe('https://tv.example.com');
    expect(config.youtube.source).toBe('holodex');
    expect(config.youtube.channels).toEqual([{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa' }, { id: '@handle', name: 'N', group: 'G' }]);
    expect(config.youtube.playback).toBe('mux');
    expect(config.youtube.quality).toBe(720);
    expect(config.youtube.proxy).toBe('socks5://127.0.0.1:1080');
  });

  test('env overrides file', () => {
    const config = buildConfig({ youtube: { source: 'holodex', quality: 1080 } }, {
      YT_SOURCE: 'dataapi',
      YT_DATA_API_KEY: 'key',
      YT_QUALITY: 'best',
      YT_CHANNELS: 'UCaaaaaaaaaaaaaaaaaaaaaa:频道A, @b',
      YT_PROXY: 'http://127.0.0.1:7890',
      PORT: '8080',
      SERVICE_URL: 'http://a/',
    });
    expect(config.youtube.source).toBe('dataapi');
    expect(config.youtube.dataApiKey).toBe('key');
    expect(config.youtube.quality).toBe(0);
    expect(config.youtube.channels).toEqual([{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: '频道A' }, { id: '@b' }]);
    expect(config.youtube.proxy).toBe('http://127.0.0.1:7890');
    expect(config.port).toBe(8080);
    expect(config.serviceUrl).toBe('http://a');
  });

  test('invalid enum values fall back', () => {
    const config = buildConfig({ youtube: { source: 'nope', playback: 'nope' } }, {});
    expect(config.youtube.source).toBe('local');
    expect(config.youtube.playback).toBe('passthrough');
  });

  test('parseQuality / parseChannelList', () => {
    expect(parseQuality('1080p')).toBe(1080);
    expect(parseQuality(480)).toBe(480);
    expect(parseQuality('best')).toBe(0);
    expect(parseQuality('garbage')).toBe(0);
    expect(parseChannelList(' , @a ,UCbbbbbbbbbbbbbbbbbbbbbb:B ')).toEqual([{ id: '@a' }, { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'B' }]);
  });
});
