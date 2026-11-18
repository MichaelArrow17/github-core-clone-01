// app.ts — the forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL
// and MCP from the store. Auth is a Bearer token: when MAKEFUN_SHOP_TOKEN is set in the
// environment it must match exactly; otherwise any non-empty Bearer token is accepted
// (the local runner's token). Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id; unknown routes are JSON 404s, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitPost, handleInfoRefs } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const allHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  };
  if (body !== null) allHeaders['content-length'] = String(Buffer.byteLength(text));
  else allHeaders['content-length'] = '0';
  res.writeHead(status, allHeaders);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${++requestCounter}`,
  });
  res.end(body);
}

function sendMessage(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathAndQuery(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

const store = new Store();

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        // Never crash the process on a bad request: answer 500 JSON and keep serving.
        try {
          sendMessage(res, 500, `internal error: ${(err as Error).message}`);
        } catch {
          try {
            res.destroy();
          } catch {
            // ignore
          }
        }
      }
    })();
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = pathAndQuery(req);
  const method = req.method ?? 'GET';
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  // The env's boot probe: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendMessage(res, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const result = handleGraphQL(store, body.toString('utf8'));
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendMessage(res, 404, 'Not Found');
      return;
    }
    const authorized = isAuthorized(req);
    const body = await readBody(req);
    const result = handleMcp(store, body.toString('utf8'), authorized);
    if (result.body === null) {
      res.writeHead(result.status, { 'content-length': '0', 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/{service}.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3];
    if (method === 'GET' && suffix === '/info/refs') {
      const service = query.get('service') ?? '';
      const result = handleInfoRefs(store, owner, repoName, service, query, headers);
      if (result.status !== 200) {
        sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
        return;
      }
      sendBuffer(res, 200, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && (suffix === '/git-upload-pack' || suffix === '/git-receive-pack')) {
      const service = suffix.slice(1);
      const body = await readBody(req);
      const result = handleGitPost(store, owner, repoName, service, body, headers);
      if (result.status !== 200) {
        sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
        return;
      }
      sendBuffer(res, 200, result.contentType, result.body);
      return;
    }
    sendMessage(res, 404, 'Not Found');
    return;
  }

  // REST v3: everything under /api/v3 needs a token.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return;
        }
      }
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest(store, method, path, query, body, origin);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  sendMessage(res, 404, 'Not Found');
}
