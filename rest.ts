// rest.ts — the GitHub REST v3 surface the suite drives, under /api/v3. Every reply is
// application/json with a non-empty X-GitHub-Request-Id; errors are {"message": string}.
// Auth: a Bearer token is required on every /api/v3 route (401 without one).

import { hashObject, isObjectId, ZERO_OID } from './gitcodec.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export interface RepoJsonOptions {
  includePrivate?: boolean;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url')}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

/** A GitHub-style Link header for a paginated list (next/prev/first/last as applicable). */
function linkHeader(base: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${url(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${url(page - 1)}; rel="prev"`);
  parts.push(`${url(1)}; rel="first"`);
  parts.push(`${url(totalPages)}; rel="last"`);
  return parts.length ? parts.join(', ') : null;
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Decode a request JSON body; null when absent, throws on malformed JSON. */
export function parseJsonBody(text: string): unknown {
  if (text === '') return null;
  return JSON.parse(text);
}

export type RestHandler = (
  store: Store,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
  method: string,
) => RestResult | Promise<RestResult>;

/** Resolve a repo from the route params; 404 when missing or owned by someone else. */
function needRepo(store: Store, owner: string, name: string): Repo | RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function branchTip(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (store.resolveRef(repo, ref) !== undefined) return store.resolveRef(repo, ref);
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
  return undefined;
}

/** Read one file (or directory) from a tree at a ref. */
function contentsRead(
  store: Store,
  repo: Repo,
  path: string,
  ref: string | null,
): RestResult {
  const tip = branchTip(store, repo, ref);
  if (!tip) return err(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
  const rootTree = parseCommit(commit.data).tree;
  const segments = path === '' ? [] : path.split('/');
  let currentTree = rootTree;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const treeObject = repo.objects.get(currentTree);
    if (!treeObject || treeObject.type !== 'tree') return err(404, 'Not Found');
    const entry = parseTree(treeObject.data).find((candidate: { name: string }) => candidate.name === segment);
    if (!entry) return err(404, 'Not Found');
    const isLast = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (!isLast) {
        currentTree = entry.oid;
        continue;
      }
      // A directory: list its entries.
      const dirObject = repo.objects.get(entry.oid);
      if (!dirObject || dirObject.type !== 'tree') return err(404, 'Not Found');
      const listing = parseTree(dirObject.data).map((child: { mode: string; name: string; oid: string }) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: `${path}/${child.name}`,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${child.name}`,
      }));
      return json(200, listing);
    }
    if (!isLast) return err(404, 'Not Found');
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segment,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    });
  }
  // The root directory.
  const rootObject = repo.objects.get(rootTree);
  if (!rootObject || rootObject.type !== 'tree') return err(404, 'Not Found');
  const listing = parseTree(rootObject.data).map((child: { mode: string; name: string; oid: string }) => ({
    type: child.mode === '40000' ? 'dir' : 'file',
    name: child.name,
    path: child.name,
    sha: child.oid,
    size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${child.name}`,
  }));
  return json(200, listing);
}

// The tree/commit parsers live in gitcodec.ts.
import { parseCommit, parseTree } from './gitcodec.ts';

/** Write (create/update) or delete one file through PUT/DELETE /contents. */
function contentsWrite(
  store: Store,
  repo: Repo,
  path: string,
  body: Record<string, unknown>,
  method: 'PUT' | 'DELETE',
): RestResult {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refs.get(branchRef);
  if (tip === undefined && method === 'PUT') {
    // Creating a file on a branch that does not exist yet: branch from the default tip (or unborn).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) {
      repo.refs.set(branchRef, defaultTip);
      tip = defaultTip;
    }
  }
  if (tip === undefined && method === 'DELETE') return err(404, 'Not Found');
  const baseFiles = tip === undefined ? new Map<string, string>() : store.treeFiles(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Update file';

  if (method === 'DELETE') {
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const current = baseFiles.get(path);
    if (current === undefined) return err(404, 'Not Found');
    if (sha !== undefined && sha.toLowerCase() !== current.toLowerCase()) return err(409, 'sha does not match');
    const files = new Map(baseFiles);
    files.delete(path);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = store.makeCommit(repo, files, message, parents);
    repo.refs.set(branchRef, commitSha);
    repo.version += 1;
    repo.packCache.clear();
    return json(200, { commit: { sha: commitSha, message } });
  }

  // PUT
  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null) return err(422, 'content is required');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const blobSha = hashObject('blob', bytes);
  const existing = baseFiles.get(path);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    if (sha === undefined) return err(422, 'sha is required to update a file');
    if (sha.toLowerCase() !== existing!.toLowerCase()) return err(409, 'sha does not match the current blob');
  } else if (sha !== undefined) {
    return err(422, 'sha does not match: the file does not exist');
  }
  store.putObject(repo, 'blob', bytes);
  const files = new Map(baseFiles);
  files.set(path, blobSha);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = store.makeCommit(repo, files, message, parents);
  repo.refs.set(branchRef, commitSha);
  repo.version += 1;
  repo.packCache.clear();
  return json(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobSha, size: bytes.length, encoding: 'base64', content },
    commit: { sha: commitSha, message },
  });
}

// ---------------------------------------------------------------------------------------------
// the route table
// ---------------------------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  origin = '',
): RestResult {
  const segments = path.split('/').filter((segment) => segment !== '');
  // /api/v3
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method === 'GET') {
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (segments.length < 3 || segments[0] !== 'api' || segments[1] !== 'v3') return err(404, 'Not Found');
  const rest = segments.slice(2);

  // GET /meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  // GET /user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }
  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = parsePagination(query);
      const all = store.userRepos(VIEWER_LOGIN);
      const items = paginate(all, page, perPage).map(repoJson);
      const link = linkHeader(`${origin}/api/v3/user/repos`, query, page, perPage, all.length);
      return json(200, items, link ? { link } : undefined);
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is invalid');
      const description = typeof input.description === 'string' ? input.description : '';
      const isPrivate = input.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (!repo) return err(422, 'Repository already exists');
      return json(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repoOrError = needRepo(store, owner, name);
    if (!(repoOrError as Repo).id) return repoOrError as RestResult;
    const repo = repoOrError as Repo;
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.version += 1;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /branches
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branches = store.sortedRefs(repo)
          .filter((ref) => ref.name.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
        return json(200, branches);
      }
      if (tail.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branch = decodeURIComponent(tail[1]);
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) return err(404, 'Not Found');
        return json(200, { name: branch, commit: { sha: oid } });
      }
      return err(404, 'Not Found');
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'ref or sha is invalid');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        repo.version += 1;
        repo.packCache.clear();
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).map(decodeURIComponent).join('/');
        const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = repo.refs.get(fullRef);
        if (!oid) return err(404, 'Not Found');
        return json(200, { ref: fullRef, object: { sha: oid, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // /commits
    if (tail[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = query.get('sha');
      const tip = branchTip(store, repo, ref);
      if (!tip) return json(200, []);
      const history = store.commitHistory(repo, tip);
      const { page, perPage } = parsePagination(query);
      const items = paginate(history, page, perPage).map((oid) => {
        const object = repo.objects.get(oid)!;
        const commit = parseCommit(object.data);
        return {
          sha: oid,
          commit: {
            // GitHub returns the message without git's trailing newline.
            message: commit.message.replace(/\n+$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          },
        };
      });
      return json(200, items);
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') return contentsRead(store, repo, contentPath, query.get('ref'));
      if (method === 'PUT' || method === 'DELETE') {
        return contentsWrite(store, repo, contentPath, (body ?? {}) as Record<string, unknown>, method);
      }
      return err(404, 'Not Found');
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      if (method === 'POST' && tail.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const labelName = typeof input.name === 'string' ? input.name : '';
        if (labelName === '') return err(422, 'name is required');
        const color = typeof input.color === 'string' ? input.color : 'ededed';
        const existing = repo.labels.get(labelName);
        if (existing) return json(201, { name: existing.name, color: existing.color });
        repo.labels.set(labelName, { name: labelName, color });
        repo.version += 1;
        return json(201, { name: labelName, color });
      }
      return err(404, 'Not Found');
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, perPage } = parsePagination(query);
          return json(200, paginate(list, page, perPage).map((issue) => issueJson(repo, issue)));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const issueBody = typeof input.body === 'string' ? input.body : '';
          if (title === '') return err(422, 'title is required');
          const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (!label) return err(422, `label ${labelName} does not exist`);
            labels.push(label);
          }
          const issue = store.createIssue(repo, title, issueBody, labels);
          return json(201, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.get(number);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) return err(404, 'Not Found');
          return json(200, issueJson(repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return err(404, 'Not Found');
          const input = (body ?? {}) as Record<string, unknown>;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          repo.version += 1;
          return json(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const commentBody = typeof input.body === 'string' ? input.body : '';
          if (commentBody === '') return err(422, 'body is required');
          const comment = store.createComment(repo, issue, commentBody);
          return json(201, { id: comment.id, body: comment.body });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { page, perPage } = parsePagination(query);
          return json(200, paginate(list, page, perPage).map((pull) => pullJson(repo, pull)));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const pullBody = typeof input.body === 'string' ? input.body : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha) return err(422, `head branch ${head} does not exist`);
          if (!baseSha) return err(422, `base branch ${base} does not exist`);
          for (const existing of repo.pulls.values()) {
            if (existing.head === head && existing.base === base && existing.state === 'open') {
              return err(422, 'A pull request already exists for this branch');
            }
          }
          const pull = store.createPull(repo, title, pullBody, head, base, headSha, baseSha);
          return json(201, pullJson(repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (tail.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        return json(200, pullJson(repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        return json(200, store.diffFiles(repo, pull.baseSha, pull.headSha));
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        if (pull.state === 'closed') {
          if (pull.merged) return err(405, 'Pull request is already merged');
          return err(405, 'Pull request is closed');
        }
        const mergeSha = store.mergePull(repo, pull);
        if (mergeSha === null) return err(405, 'Merge conflict');
        return json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

export { ZERO_OID };
