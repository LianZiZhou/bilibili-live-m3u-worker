import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import config from './config';
import { logger } from './middleware/logger';
import { renderM3U, renderXMLTV } from './utils/playlist';
import { getBaseUrl } from './utils/request';

import bililive, { buildBiliGuide, buildBiliM3UEntries } from "./routes/bililive";
import ytlive, { buildYTGuide, buildYTM3UEntries } from "./routes/ytlive";

const app = new Hono();

app.use(logger());

app.route('', bililive);

app.route('', ytlive);

// Bilibili + YouTube in one playlist, grouped by group-title
app.get('/subscribe/all/live.m3u', async (c) => {
  const base = getBaseUrl(c);
  const [bili, yt] = await Promise.all([
    buildBiliM3UEntries(base).catch((e) => {
      console.error(e);
      return [];
    }),
    buildYTM3UEntries(base).catch((e) => {
      console.error(e);
      return [];
    }),
  ]);
  return c.text(renderM3U([...bili, ...yt], { 'x-tvg-url': `${base}/subscribe/all/guide.xml` }));
});

app.get('/subscribe/all/guide.xml', async (c) => {
  const base = getBaseUrl(c);
  const empty = { channels: [], programmes: [] };
  const [bili, yt] = await Promise.all([
    buildBiliGuide(base).catch((e) => {
      console.error(e);
      return empty;
    }),
    buildYTGuide(base).catch((e) => {
      console.error(e);
      return empty;
    }),
  ]);
  c.header('content-type', 'application/xml; charset=utf-8');
  return c.body(renderXMLTV([...bili.channels, ...yt.channels], [...bili.programmes, ...yt.programmes]));
});

const isBun = typeof (globalThis as any).Bun !== 'undefined';

// Bun serves the default export itself, Node needs the adapter
if(!isBun) {
  serve({
    port: config.port,
    fetch: app.fetch,
  });
}

console.log(`Listening on port ${config.port}`);

export default {
  port: config.port,
  // muxing a segment can take a while
  idleTimeout: 60,
  fetch: app.fetch,
};
