import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A stand-in for the Hibira HTTP API that records requests and answers with `reply`. */
export async function fakeApi(reply: (req: Recorded) => { status?: number; body?: unknown } = () => ({ body: {} })) {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const rec: Recorded = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(rec);
      const out = reply(rec);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const creds = { appId: '1001', key: 'test-key', secret: 'test-secret-0123456789' };

export async function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}
