import { describe, expect, test } from 'bun:test';
import { buildMediaPlaylist, extractYTSeq, parseMasterPlaylist, parseMediaPlaylist, rewriteMediaPlaylist, selectVariant } from '../src/utils/hls';

const MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=290288,CODECS="mp4a.40.5,avc1.42C00B",RESOLUTION=256x144,FRAME-RATE=15,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE
https://manifest.googlevideo.com/api/manifest/hls_playlist/id/x.1/itag/91/playlist/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2969452,CODECS="mp4a.40.2,avc1.4D401F",RESOLUTION=1280x720,FRAME-RATE=30,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE
https://manifest.googlevideo.com/api/manifest/hls_playlist/id/x.1/itag/95/playlist/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5420722,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1920x1080,FRAME-RATE=30,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE
https://manifest.googlevideo.com/api/manifest/hls_playlist/id/x.1/itag/96/playlist/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:71577
#EXT-X-PROGRAM-DATE-TIME:2026-09-27T20:00:00.000+00:00
#EXTINF:5.0,
https://rr1---sn-x.googlevideo.com/videoplayback/id/x.1/itag/96/source/yt_live_broadcast/sq/71577/goap/clen%3D1/file/seg.ts
#EXTINF:5.0,
https://rr1---sn-x.googlevideo.com/videoplayback/id/x.1/itag/96/source/yt_live_broadcast/sq/71578/goap/clen%3D1/file/seg.ts
#EXTINF:4.8,
https://rr1---sn-x.googlevideo.com/videoplayback/id/x.1/itag/96/source/yt_live_broadcast/sq/71579/goap/clen%3D1/file/seg.ts
`;

describe('hls', () => {
  test('parseMasterPlaylist', () => {
    const variants = parseMasterPlaylist(MASTER);
    expect(variants).toHaveLength(3);
    expect(variants[0]).toMatchObject({ width: 256, height: 144, fps: 15, bandwidth: 290288, codecs: 'mp4a.40.5,avc1.42C00B' });
    expect(variants[2].uri).toContain('/itag/96/');
  });

  test('selectVariant', () => {
    const variants = parseMasterPlaylist(MASTER);
    expect(selectVariant(variants, 0)!.height).toBe(1080);
    expect(selectVariant(variants, 720)!.height).toBe(720);
    expect(selectVariant(variants, 1000)!.height).toBe(720);
    // nothing fits: lowest
    expect(selectVariant(variants, 100)!.height).toBe(144);
    expect(selectVariant([], 0)).toBeUndefined();
  });

  test('extractYTSeq', () => {
    expect(extractYTSeq('https://x/videoplayback/sq/123/file/seg.ts')).toBe(123);
    expect(extractYTSeq('https://x/videoplayback?itag=140&sq=55')).toBe(55);
    expect(extractYTSeq('https://x/seg.ts')).toBeNull();
  });

  test('parseMediaPlaylist', () => {
    const playlist = parseMediaPlaylist(MEDIA);
    expect(playlist.targetDuration).toBe(5);
    expect(playlist.mediaSequence).toBe(71577);
    expect(playlist.ended).toBe(false);
    expect(playlist.segments.map((s) => s.seq)).toEqual([71577, 71578, 71579]);
    expect(playlist.segments[2].duration).toBe(4.8);
  });

  test('parseMediaPlaylist falls back to media sequence', () => {
    const playlist = parseMediaPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n');
    expect(playlist.segments.map((s) => s.seq)).toEqual([10, 11]);
    expect(playlist.ended).toBe(true);
  });

  test('rewriteMediaPlaylist', () => {
    const text = rewriteMediaPlaylist(MEDIA, (s) => `/seg/${s.seq}.ts`, 1000);
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:72577');
    expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:2026-09-27T20:00:00.000+00:00');
    expect(text).not.toContain('googlevideo');
    expect(text.split('\n').filter((l) => l.startsWith('/seg/'))).toEqual(['/seg/71577.ts', '/seg/71578.ts', '/seg/71579.ts']);
  });

  test('buildMediaPlaylist', () => {
    const text = buildMediaPlaylist({
      targetDuration: 4.2,
      mediaSequence: 7,
      discontinuitySequence: 7,
      segments: [{ uri: 'a.ts', duration: 4, discontinuity: true }, { uri: 'b.ts', duration: 4 }],
    });
    expect(text).toBe('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n'
      + '#EXT-X-DISCONTINUITY\n#EXTINF:4.000,\na.ts\n#EXTINF:4.000,\nb.ts\n');
  });
});
