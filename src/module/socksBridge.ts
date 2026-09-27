import net = require('net');
import { SocksClient } from 'socks';
import type { ParsedProxy } from './proxy';

/**
 * Bun's fetch only understands http(s) proxies, so socks proxies are exposed
 * through a small local HTTP proxy that tunnels every connection via socks.
 * Supports CONNECT (https targets) and absolute-form requests (http targets).
 */
export function startSocksBridge(proxy: ParsedProxy): Promise<{ url: string; close: () => void }> {
  const connectVia = (host: string, port: number) => SocksClient.createConnection({
    command: 'connect',
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: proxy.type === 'socks4' ? 4 : 5,
      userId: proxy.username,
      password: proxy.password,
    },
    destination: { host, port },
    timeout: 15000,
  }).then(({ socket }) => socket);

  const server = net.createServer((client) => {
    let buffered = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if(headerEnd < 0) {
        if(buffered.length > 64 * 1024) client.destroy();
        return;
      }
      client.removeListener('data', onData);
      client.pause();
      const head = buffered.subarray(0, headerEnd).toString('latin1');
      const rest = buffered.subarray(headerEnd + 4);
      const [requestLine, ...headerLines] = head.split('\r\n');
      const [method, target, version] = requestLine.split(' ');
      try {
        if(method === 'CONNECT') {
          const idx = target.lastIndexOf(':');
          const host = target.slice(0, idx).replace(/^\[|\]$/g, '');
          const port = Number(target.slice(idx + 1)) || 443;
          const upstream = await connectVia(host, port);
          client.write(`${version || 'HTTP/1.1'} 200 Connection Established\r\n\r\n`);
          if(rest.length > 0) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          return;
        }
        const url = new URL(target);
        const upstream = await connectVia(url.hostname, Number(url.port) || 80);
        const filteredHeaders = headerLines.filter((line) => !/^proxy-/i.test(line));
        upstream.write(`${method} ${url.pathname}${url.search} ${version}\r\n${filteredHeaders.join('\r\n')}\r\n\r\n`);
        if(rest.length > 0) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      }
      catch(e: any) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nSocks proxy error: ${e?.message || e}`);
      }
    };
    client.on('data', onData);
    client.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() });
    });
  });
}
