import type { Context } from 'hono';
import config from '../config';

// public base url of this service, used for absolute urls in playlists
export function getBaseUrl(c: Context): string {
  if(config.serviceUrl) {
    return config.serviceUrl;
  }
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(/:$/, '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}
