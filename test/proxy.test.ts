import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net = require('net');
import { createFetch, parseProxyUrl } from '../src/module/proxy';

describe('parseProxyUrl', () => {
  test('protocols', () => {
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('http://127.0.0.1:7890')).toMatchObject({ type: 'http', host: '127.0.0.1', port: 7890 });
    expect(parseProxyUrl('https://proxy.example.com')).toMatchObject({ type: 'http', port: 443 });
    expect(parseProxyUrl('socks5h://user:p%40ss@[::1]:1080')).toMatchObject({ type: 'socks5', host: '::1', port: 1080, username: 'user', password: 'p@ss' });
    expect(parseProxyUrl('socks://h')).toMatchObject({ type: 'socks5', port: 1080 });
    expect(parseProxyUrl('socks4://h:1081')).toMatchObject({ type: 'socks4', port: 1081 });
    expect(() => parseProxyUrl('ftp://h')).toThrow();
  });
});

describe('socks bridge', () => {
  let target: ReturnType<typeof Bun.serve>;
  let socks: net.Server;
  let socksPort = 0;
  const requested: { host: string; port: number; auth?: string }[] = [];

  beforeAll(async () => {
    target = Bun.serve({ port: 0, fetch: (req) => new Response(`hello ${new URL(req.url).pathname} ${req.headers.get('x-test') || ''}`) });
    // minimal SOCKS5 server; records the requested destination and always connects to the local target
    socks = net.createServer((client) => {
      let auth: string | undefined;
      client.once('data', (greeting: Buffer) => {
        const methods = Array.from(greeting.subarray(2, 2 + greeting[1]));
        const useAuth = methods.includes(2);
        client.write(Buffer.from([5, useAuth ? 2 : 0]));
        const onRequest = (req: Buffer) => {
          let host: string, offset: number;
          if(req[3] === 3) {
            host = req.subarray(5, 5 + req[4]).toString();
            offset = 5 + req[4];
          }
          else {
            host = Array.from(req.subarray(4, 8)).join('.');
            offset = 8;
          }
          requested.push({ host, port: req.readUInt16BE(offset), auth });
          const upstream = net.connect(target.port!, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
        };
        if(useAuth) {
          client.once('data', (a: Buffer) => {
            const user = a.subarray(2, 2 + a[1]).toString();
            const pass = a.subarray(3 + a[1], 3 + a[1] + a[2 + a[1]]).toString();
            auth = `${user}:${pass}`;
            client.write(Buffer.from([1, 0]));
            client.once('data', onRequest);
          });
        }
        else {
          client.once('data', onRequest);
        }
      });
    });
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve));
    socksPort = (socks.address() as net.AddressInfo).port;
  });

  afterAll(() => {
    target.stop(true);
    socks.close();
  });

  test('http request through socks5 with auth', async () => {
    const f = createFetch(`socks5h://alice:secret@127.0.0.1:${socksPort}`);
    const response = await f('http://yt-proxy-test.invalid:8080/abc?x=1', { headers: { 'x-test': 'yes' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello /abc yes');
    expect(requested.at(-1)).toEqual({ host: 'yt-proxy-test.invalid', port: 8080, auth: 'alice:secret' });
  });

  test('Request objects are supported', async () => {
    const f = createFetch(`socks5://127.0.0.1:${socksPort}`);
    const response = await f(new Request('http://yt-proxy-test.invalid/req', { headers: { 'x-test': 'r' } }));
    expect(await response.text()).toBe('hello /req r');
    expect(requested.at(-1)!.auth).toBeUndefined();
  });

  test('unreachable socks proxy does not silently go direct', async () => {
    const f = createFetch('socks5://127.0.0.1:1');
    let failed = false;
    try {
      const response = await f('http://yt-proxy-test.invalid/x');
      failed = response.status >= 500;
    }
    catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
