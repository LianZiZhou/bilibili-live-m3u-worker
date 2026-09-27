import { describe, expect, test } from 'bun:test';
import { renderM3U, renderXMLTV, xmlEscape, xmltvTime } from '../src/utils/playlist';

describe('playlist', () => {
  test('xmlEscape', () => {
    expect(xmlEscape(`a & b <c> "d" 'e'`)).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
    expect(xmlEscape(undefined)).toBe('');
  });

  test('xmltvTime', () => {
    expect(xmltvTime(new Date('2026-09-27T08:05:09Z'))).toBe('20260927080509 +0000');
  });

  test('renderM3U', () => {
    const text = renderM3U([
      { id: 'yt-UC1', name: 'Name "quoted"\nnewline', logo: 'http://x/a.jpg', group: 'YouTube', url: 'http://x/play.m3u8' },
    ], { 'x-tvg-url': 'http://x/guide.xml' });
    expect(text).toBe('#EXTM3U x-tvg-url="http://x/guide.xml"\n'
      + `#EXTINF:-1 tvg-id="yt-UC1" tvg-name="Name 'quoted' newline" tvg-logo="http://x/a.jpg" group-title="YouTube",Name "quoted" newline\n`
      + 'http://x/play.m3u8\n');
  });

  test('renderXMLTV escapes titles', () => {
    const xml = renderXMLTV(
      [{ id: 'c1', name: 'A&B', icon: 'http://x/i.jpg?a=1&b=2' }],
      [{ channel: 'c1', start: new Date('2024-01-01T00:00:00Z'), stop: new Date('2077-01-01T00:00:00Z'), title: '<Live> & chill' }],
    );
    expect(xml).toContain('<display-name>A&amp;B</display-name>');
    expect(xml).toContain('<icon src="http://x/i.jpg?a=1&amp;b=2"/>');
    expect(xml).toContain('<title lang="zh">&lt;Live&gt; &amp; chill</title>');
    expect(xml).toContain('start="20240101000000 +0000" stop="20770101000000 +0000"');
  });
});
