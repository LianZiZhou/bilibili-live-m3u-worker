import config from '../config';
import { startSocksBridge } from './socksBridge';

export type ProxyType = 'http' | 'socks4' | 'socks5';

export interface ParsedProxy {
  type: ProxyType;
  url: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyUrl(proxy: string): ParsedProxy | null {
  if(!proxy) {
    return null;
  }
  const url = new URL(proxy);
  const protocol = url.protocol.replace(/:$/, '');
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  switch(protocol) {
    case 'http':
    case 'https':
      return { type: 'http', url: proxy, host, port: Number(url.port) || (protocol === 'https' ? 443 : 80), username, password };
    case 'socks':
    case 'socks5':
    case 'socks5h':
      return { type: 'socks5', url: proxy, host, port: Number(url.port) || 1080, username, password };
    case 'socks4':
    case 'socks4a':
      return { type: 'socks4', url: proxy, host, port: Number(url.port) || 1080, username };
    default:
      throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const isBun = typeof (globalThis as any).Bun !== 'undefined';

// Build a fetch that sends requests through an http proxy url
async function createHttpProxyFetch(proxyUrl: string): Promise<FetchLike> {
  if(isBun) {
    // Bun's native fetch supports http(s) proxies directly
    return (input, init) => fetch(input, { ...(init || {}), proxy: proxyUrl } as RequestInit);
  }
  // Node: global fetch ignores proxies, use undici with a ProxyAgent dispatcher
  const { ProxyAgent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new ProxyAgent(proxyUrl);
  return async (input, init) => {
    let url: string;
    let requestInit: any = { ...(init || {}) };
    if(input instanceof Request) {
      url = input.url;
      requestInit = {
        method: input.method,
        headers: Array.from(input.headers.entries()),
        body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.arrayBuffer(),
        signal: input.signal,
        redirect: input.redirect,
        ...requestInit,
      };
    }
    else {
      url = input.toString();
    }
    if(requestInit.headers instanceof Headers) {
      requestInit.headers = Array.from(requestInit.headers.entries());
    }
    requestInit.dispatcher = dispatcher;
    return await undiciFetch(url, requestInit) as unknown as Response;
  };
}

export function createFetch(proxy: string): FetchLike {
  const parsed = parseProxyUrl(proxy);
  if(!parsed) {
    return (input, init) => fetch(input, init);
  }
  let ready: Promise<FetchLike>;
  if(parsed.type === 'http') {
    ready = createHttpProxyFetch(parsed.url);
  }
  else {
    ready = startSocksBridge(parsed).then((bridge) => createHttpProxyFetch(bridge.url));
  }
  return async (input, init) => (await ready)(input, init);
}

// fetch used for every request that goes to YouTube / Holodex / Google APIs
export const ytFetch: FetchLike = createFetch(config.youtube.proxy);

if(config.youtube.proxy) {
  const parsed = parseProxyUrl(config.youtube.proxy)!;
  console.log(`YouTube requests use ${parsed.type} proxy ${parsed.host}:${parsed.port}`);
}
