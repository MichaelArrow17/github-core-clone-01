// store.ts — the forge's in-memory state: repositories, git objects, refs, issues, pull
// requests, labels and comments. One process, no disk: everything lives here and is
// deterministic (no wall clock, no randomness in stored state).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcodec.ts';

/** The login the entry's bearer token names (the suite's scenario viewer, from the kit's fixed seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** A fixed epoch for server-generated commits; each commit takes the next second, so bytes are deterministic. */
const COMMIT_EPOCH = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  comments: Comment[];
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue + pull-request number counter (GitHub numbers them together). */
  nextNumber: number;
  labels: Map<string, Label>;
  commentSeq: number;
  commitSeq: number;
  /** Bumps on every mutation; pack/advertisement caches key on it. */
  version: number;
  /** Cached pack bytes for fetch requests, keyed by wants/depth/haves at this version. */
  packCache: Map<string, { pack: Buffer; shallow: string[] }>;
}

export class Store {
  repos = new Map<string, Repo>();
  /** Repositories in creation order (for GET /user/repos pagination). */
  repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private repoSeq = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repoList) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: ++this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      commentSeq: 0,
      commitSeq: 0,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (!repo) return false;
    this.repos.delete(key);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    return true;
  }

  userRepos(owner: string): Repo[] {
    return this.repoList.filter((repo) => repo.owner === owner);
  }

  /** The token owner's global (Relay) id for a repository: opaque, stable, not the database id. */
  repoGlobalId(repo: Repo): string {
    return `R_${Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url')}`;
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return `I_${Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url')}`;
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return `P_${Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url')}`;
  }

  commentGlobalId(repo: Repo, comment: Comment): string {
    return `C_${Buffer.from(`IssueComment:${repo.id}:${comment.id}`, 'utf8').toString('base64url')}`;
  }

  /** Resolve an opaque global id back to its object (repository, issue, pull request, comment). */
  resolveGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    const match = /^([RIPC])_(.+)$/.exec(id);
    if (!match) return null;
    const kind = match[1];
    let decoded = '';
    try {
      decoded = Buffer.from(match[2], 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const parts = decoded.split(':');
    if (kind === 'R' && parts[0] === 'Repository' && parts.length === 2) {
      const repo = this.getRepoById(Number(parts[1]));
      return repo ? { kind: 'repo', repo } : null;
    }
    if (kind === 'I' && parts[0] === 'Issue' && parts.length === 3) {
      const repo = this.getRepoById(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      return repo && issue ? { kind: 'issue', repo, issue } : null;
    }
    if (kind === 'P' && parts[0] === 'PullRequest' && parts.length === 3) {
      const repo = this.getRepoById(Number(parts[1]));
      const pull = repo?.pulls.get(Number(parts[2]));
      return repo && pull ? { kind: 'pull', repo, pull } : null;
    }
    if (kind === 'C' && parts[0] === 'IssueComment' && parts.length === 3) {
      const repo = this.getRepoById(Number(parts[1]));
      if (!repo) return null;
      for (const issue of repo.issues.values()) {
        const comment = issue.comments.find((c) => c.id === Number(parts[2]));
        if (comment) return { kind: 'comment', repo, issue, comment };
      }
      return null;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The ref a name resolves to (HEAD follows the default branch). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }

  /** All refs sorted by name (HEAD excluded; callers add it). */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The annotated tag's target commit, or undefined when the object is not an annotated tag. */
  peeledTarget(repo: Repo, oid: string): string | undefined {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tag') return undefined;
    return parseTag(object.data).object;
  }

  // -------------------------------------------------------------------------------------------
  // trees: a repo's current file map per commit
  // -------------------------------------------------------------------------------------------

  /** The flat path -> blob oid map of a commit's tree (recursive). */
  treeFiles(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, childPath);
        else if (entry.mode !== '160000') out.set(childPath, entry.oid);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path -> blob oid map. Returns the tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of [...files.entries()].sort()) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a server-side commit on a branch tip (or unborn). Returns the commit oid. */
  makeCommit(repo: Repo, files: Map<string, string>, message: string, parents: readonly string[]): string {
    const tree = this.buildTreeFromFiles(repo, files);
    const timestamp = COMMIT_EPOCH + repo.commitSeq++;
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The commit history of a ref, newest first, following first parents. */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = tip;
    while (current && current !== ZERO_OID && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      out.push(current);
      const commit = parseCommit(object.data);
      current = commit.parents[0];
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (following parents). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits (first common ancestor in a breadth-first walk from both). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * A three-way file-level merge: base tree, head tree, current tree. Returns the merged file map,
   * or null when both sides changed the same path to different contents.
   */
  threeWayMerge(repo: Repo, baseTip: string, headTip: string, currentTip: string): Map<string, string> | null {
    const baseTree = baseTip === ZERO_OID ? null : parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
    const baseFiles = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, string>();
    const headFiles = this.treeFiles(repo, headTree);
    const currentFiles = this.treeFiles(repo, currentTree);
    const merged = new Map<string, string>(currentFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const current = currentFiles.get(path);
      if (head === base) continue; // head did not change it: keep current
      if (current === base) {
        // only head changed it: take head's version (or delete when head removed it)
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
        continue;
      }
      if (head === current) continue; // both changed it the same way
      return null; // both changed it differently: conflict
    }
    return merged;
  }

  /** The files changed between two trees (base -> head), with line counts for the PR files view. */
  diffFiles(repo: Repo, baseTip: string, headTip: string): PullFile[] {
    const baseTree = baseTip === ZERO_OID ? null : parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseFiles = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, string>();
    const headFiles = this.treeFiles(repo, headTree);
    const out: PullFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base === head) continue;
      const countLines = (oid: string | undefined): number => {
        if (oid === undefined) return 0;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'blob') return 0;
        const text = object.data.toString('utf8');
        if (text === '') return 0;
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      if (base === undefined && head !== undefined) {
        const additions = Math.max(1, countLines(head));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base !== undefined && head === undefined) {
        const deletions = Math.max(1, countLines(base));
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const additions = Math.max(1, countLines(head));
        const deletions = countLines(base);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull request merges cleanly into its base's current tip (dry run). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!baseTip) return false;
    const base = this.mergeBase(repo, pull.headSha, baseTip) ?? pull.baseSha;
    const merged = this.threeWayMerge(repo, base, pull.headSha, baseTip);
    return merged !== null;
  }

  // -------------------------------------------------------------------------------------------
  // issues / pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.nextNumber,
    };
    repo.issues.set(issue.number, issue);
    repo.version += 1;
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      comments: [],
      seq: repo.nextNumber,
    };
    repo.pulls.set(pull.number, pull);
    repo.version += 1;
    return pull;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, seq: ++repo.commentSeq };
    issue.comments.push(comment);
    repo.version += 1;
    return comment;
  }

  createPullComment(repo: Repo, pull: Pull, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, seq: ++repo.commentSeq };
    pull.comments.push(comment);
    repo.version += 1;
    return comment;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    const baseRef = `refs/heads/${pull.base}`;
    const baseTip = repo.refs.get(baseRef);
    if (!baseTip) return null;
    const base = this.mergeBase(repo, pull.headSha, baseTip) ?? pull.baseSha;
    const mergedFiles = this.threeWayMerge(repo, base, pull.headSha, baseTip);
    if (mergedFiles === null) return null;
    const timestamp = COMMIT_EPOCH + repo.commitSeq++;
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const mergeCommit = this.makeCommitWithTimestamp(repo, mergedFiles, message, [baseTip], timestamp);
    repo.refs.set(baseRef, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(timestamp * 1000).toISOString();
    pull.mergeCommitSha = mergeCommit;
    repo.version += 1;
    repo.packCache.clear();
    return mergeCommit;
  }

  makeCommitWithTimestamp(repo: Repo, files: Map<string, string>, message: string, parents: readonly string[], timestamp: number): string {
    const tree = this.buildTreeFromFiles(repo, files);
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Reachability of a ref's tip, for the fetch exclusion set. */
  reachableFrom(repo: Repo, tip: string): Set<string> {
    try {
      return collectReachable([tip], this.lookup(repo));
    } catch {
      return new Set();
    }
  }
}
