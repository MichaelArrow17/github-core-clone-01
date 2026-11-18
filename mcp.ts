// mcp.ts — the Model Context Protocol endpoint at POST /mcp (Streamable HTTP, JSON bodies).
// Speaks the 2026-07-28 revision: `server/discover` answers identity, capabilities and
// supportedVersions; every request is JSON-RPC 2.0 and answered with its own id echoed. A
// legacy `initialize` handshake is also answered, for servers that predate discover.
// Tools act on the same store as REST, so a repository or issue created over MCP reads back
// over /api/v3 as the same object.

import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER_LOGIN, type Store } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const SERVER_NAME = 'github-core-clone';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

export interface McpResult {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolText(payload: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolErrorText(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Execute one tool call against the store. Returns a tool result or a JSON-RPC error code/message. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool ${name}` } };
  const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) {
    return { error: { code: -32602, message: `missing required argument(s): ${missing.join(', ')}` } };
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number => (typeof value === 'number' ? value : Number.parseInt(String(value), 10));

  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
      return { result: toolErrorText(`invalid repository name ${JSON.stringify(repoName)}`) };
    }
    const repo = store.createRepo(VIEWER_LOGIN, repoName, str(args.description), args.private === true);
    if (!repo) return { result: toolErrorText(`repository ${repoName} already exists`) };
    return { result: toolText(repoJson(repo)) };
  }

  const owner = str(args.owner);
  const repoName = str(args.repo);
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { result: toolErrorText(`repository ${owner}/${repoName} not found`) };

  if (name === 'get_repo') {
    return { result: toolText(repoJson(repo)) };
  }
  if (name === 'create_issue') {
    const issue = store.createIssue(repo, str(args.title), str(args.body), []);
    return { result: toolText(issueJson(repo, issue)) };
  }
  if (name === 'list_issues') {
    const state = str(args.state) || 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    return { result: toolText({ issues: list.map((issue) => issueJson(repo, issue)) }) };
  }
  if (name === 'create_pull_request') {
    const head = str(args.head);
    const base = str(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return { result: toolErrorText(`head branch ${head} does not exist`) };
    if (!baseSha) return { result: toolErrorText(`base branch ${base} does not exist`) };
    for (const existing of repo.pulls.values()) {
      if (existing.head === head && existing.base === base && existing.state === 'open') {
        return { result: toolErrorText('A pull request already exists for this branch') };
      }
    }
    const pull = store.createPull(repo, str(args.title), str(args.body), head, base, headSha, baseSha);
    return { result: toolText(pullJson(repo, pull)) };
  }
  if (name === 'merge_pull_request') {
    const number = num(args.pull_number);
    const pull = repo.pulls.get(number);
    if (!pull) return { result: toolErrorText(`pull request #${number} not found`) };
    if (pull.state === 'closed') return { result: toolErrorText(`pull request #${number} is already closed`) };
    const mergeSha = store.mergePull(repo, pull);
    if (mergeSha === null) return { result: toolErrorText(`pull request #${number} has a merge conflict`) };
    return { result: toolText({ ...pullJson(repo, pull), sha: mergeSha }) };
  }
  return { error: { code: -32602, message: `unknown tool ${name}` } };
}

/** POST /mcp. `authorized` is false when no valid Bearer token was presented (HTTP 401). */
export function handleMcp(store: Store, bodyText: string, authorized: boolean): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC response (202, empty body).
  if (id === null && request.id === undefined) {
    return { status: 202, body: null };
  }
  if (!authorized) {
    return rpcError(id, -32000, 'Unauthorized', 401);
  }
  if (request.jsonrpc !== '2.0' || method === '') {
    return rpcError(id, -32600, 'Invalid Request');
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [MCP_VERSION, '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, toolName, args);
    if (outcome.error) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
