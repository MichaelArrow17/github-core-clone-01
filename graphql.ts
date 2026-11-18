// graphql.ts — a small GraphQL v4 executor for the documents gh and github-mcp-server send.
// A hand-rolled tokenizer + recursive-descent parser (the query language subset the suite
// uses: operations, variables, aliases, arguments, inline fragments), a fixed schema with
// validation (an unknown field is a 200 with an `errors` array naming it), and resolvers over
// the store. Supports batched operation arrays in one HTTP body.

import { VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < input.length && /[0-9]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type: varType.type, required: varType.required, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseType(): { type: string; required: boolean } {
    let required = false;
    let type = '';
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      type = `[${inner.type}]`;
      this.expectPunct(']');
    } else if (token.kind === 'name') {
      type = token.value;
    } else {
      throw new Error('expected a GraphQL type');
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') {
      this.next();
      required = true;
    }
    return { type, required };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------------------------
// schema (field lists, for validation and introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Node: ['id'],
};

const SEARCH_TYPE_VALUES = ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER', 'WIKI'];

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
      return node.value;
    case 'int':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

type Resolver = (source: unknown, args: Record<string, unknown>, ctx: ExecContext, selections: SelectionNode[]) => unknown;

function selectFields(
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  resolvers: Record<string, Resolver>,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      // An inline fragment applies when the source's type matches the condition.
      const sourceType = (source as { __typename?: string } | null)?.__typename;
      if (sourceType === undefined || sourceType === selection.typeCondition) {
        Object.assign(out, selectFields(selection.typeCondition, source, selection.selections, ctx, resolvers, path));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (!fields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [...path, responseKey] });
      continue;
    }
    const resolver = resolvers[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [...path, responseKey] });
      continue;
    }
    out[responseKey] = resolver(source, argsOf(selection, ctx.variables), ctx, selection.selections);
  }
  return out;
}

function scalar(value: unknown): unknown {
  return value === undefined ? null : value;
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    __repo: repo,
    __pull: pull,
  };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

const ISSUE_RESOLVERS: Record<string, Resolver> = {
  id: (source) => scalar((source as Record<string, unknown>).id),
  number: (source) => scalar((source as Record<string, unknown>).number),
  title: (source) => scalar((source as Record<string, unknown>).title),
  state: (source) => scalar((source as Record<string, unknown>).state),
  body: (source) => scalar((source as Record<string, unknown>).body),
};

const PULL_RESOLVERS: Record<string, Resolver> = {
  id: (source) => scalar((source as Record<string, unknown>).id),
  number: (source) => scalar((source as Record<string, unknown>).number),
  title: (source) => scalar((source as Record<string, unknown>).title),
  body: (source) => scalar((source as Record<string, unknown>).body),
  state: (source) => scalar((source as Record<string, unknown>).state),
  merged: (source) => scalar((source as Record<string, unknown>).merged),
  headRefName: (source) => scalar((source as Record<string, unknown>).headRefName),
  baseRefName: (source) => scalar((source as Record<string, unknown>).baseRefName),
  mergeable: (source) => scalar((source as Record<string, unknown>).mergeable),
  files: (source, args, ctx) => {
    const repo = (source as Record<string, unknown>).__repo as Repo;
    const pull = (source as Record<string, unknown>).__pull as Pull;
    const first = typeof args.first === 'number' ? args.first : 10;
    const files = ctx.store.diffFiles(repo, pull.baseSha, pull.headSha);
    const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
    return { __typename: 'PullRequestChangedFileConnection', nodes };
  },
};

const REPO_RESOLVERS: Record<string, Resolver> = {
  id: (source) => scalar((source as Record<string, unknown>).id),
  databaseId: (source) => scalar((source as Record<string, unknown>).databaseId),
  name: (source) => scalar((source as Record<string, unknown>).name),
  nameWithOwner: (source) => scalar((source as Record<string, unknown>).nameWithOwner),
  owner: (source, _args, ctx, selections) => {
    const owner = (source as Record<string, unknown>).owner as Record<string, unknown>;
    return selectFields('User', owner, selections, ctx, USER_RESOLVERS, []);
  },
  defaultBranchRef: (source, _args, ctx, selections) => {
    const ref = (source as Record<string, unknown>).defaultBranchRef as Record<string, unknown>;
    return selectFields('Ref', ref, selections, ctx, REF_RESOLVERS, []);
  },
  viewerPermission: (source) => scalar((source as Record<string, unknown>).viewerPermission),
  hasIssuesEnabled: (source) => scalar((source as Record<string, unknown>).hasIssuesEnabled),
  issue: (source, args, ctx, selections) => {
    const repo = (source as Record<string, unknown>).__repo as Repo;
    const store = ctx.store;
    const number = typeof args.number === 'number' ? args.number : -1;
    const issue = repo.issues.get(number);
    if (!issue) return null;
    return selectFields('Issue', issueObject(store, repo, issue), selections, ctx, ISSUE_RESOLVERS, []);
  },
  issues: (source, args, ctx, selections) => {
    const repo = (source as Record<string, unknown>).__repo as Repo;
    const store = ctx.store;
    let list = [...repo.issues.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    if (states !== null) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
      list = list.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    // Cursor pagination: `after` names the last number seen; `first` caps the page.
    const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
    if (after !== null) list = list.filter((issue) => (direction === 'asc' ? issue.number > after : issue.number < after));
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const hasNextPage = list.length > first;
    const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
    const nodes = page.map((issue) => selectFields('Issue', issueObject(store, repo, issue), selectionsFor(selections, 'nodes'), ctx, ISSUE_RESOLVERS, []));
    const connection: Record<string, unknown> = { __typename: 'IssueConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor } };
    return selectFields('IssueConnection', connection, selections, ctx, ISSUE_CONNECTION_RESOLVERS, []);
  },
  pullRequests: (source, args, ctx, selections) => {
    const repo = (source as Record<string, unknown>).__repo as Repo;
    const store = ctx.store;
    let list = [...repo.pulls.values()];
    // pullRequests(first:) lists open pull requests by default (gh's pr list).
    list = list.filter((pull) => pull.state === 'open');
    list.sort((a, b) => b.number - a.number);
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const nodes = page.map((pull) => selectFields('PullRequest', pullObject(store, repo, pull), selectionsFor(selections, 'nodes'), ctx, PULL_RESOLVERS, []));
    const connection: Record<string, unknown> = { __typename: 'PullRequestConnection', nodes };
    return selectFields('PullRequestConnection', connection, selections, ctx, PULL_CONNECTION_RESOLVERS, []);
  },
  pullRequest: (source, args, ctx, selections) => {
    const repo = (source as Record<string, unknown>).__repo as Repo;
    const store = ctx.store;
    const number = typeof args.number === 'number' ? args.number : -1;
    const pull = repo.pulls.get(number);
    if (!pull) return null;
    return selectFields('PullRequest', pullObject(store, repo, pull), selections, ctx, PULL_RESOLVERS, []);
  },
};

function selectionsFor(selections: SelectionNode[], fieldName: string): SelectionNode[] {
  for (const selection of selections) {
    if (selection.kind === 'field' && selection.name === fieldName) return selection.selections;
  }
  return [];
}

const ISSUE_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (source) => scalar((source as Record<string, unknown>).nodes),
  pageInfo: (source, _args, ctx, selections) => {
    const pageInfo = (source as Record<string, unknown>).pageInfo as Record<string, unknown>;
    return selectFields('PageInfo', pageInfo, selections, ctx, PAGE_INFO_RESOLVERS, []);
  },
};

const PULL_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (source) => scalar((source as Record<string, unknown>).nodes),
};

const PAGE_INFO_RESOLVERS: Record<string, Resolver> = {
  hasNextPage: (source) => scalar((source as Record<string, unknown>).hasNextPage),
  endCursor: (source) => scalar((source as Record<string, unknown>).endCursor),
};

const USER_RESOLVERS: Record<string, Resolver> = {
  login: (source) => scalar((source as Record<string, unknown>).login),
};

const REF_RESOLVERS: Record<string, Resolver> = {
  name: (source) => scalar((source as Record<string, unknown>).name),
};

const TYPE_RESOLVERS: Record<string, Resolver> = {
  name: (source) => scalar((source as Record<string, unknown>).name),
  fields: (source, args) => {
    const typeName = (source as Record<string, unknown>).name as string;
    void args;
    return (SCHEMA_FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', name }));
  },
  enumValues: (source, args) => {
    const typeName = (source as Record<string, unknown>).name as string;
    void args;
    if (typeName === 'SearchType') return SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }));
    return [];
  },
};

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: GqlError[] } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.type === 'query') {
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'viewer') {
        data[key] = selectFields('User', { __typename: 'User', login: VIEWER_LOGIN }, selection.selections, ctx, USER_RESOLVERS, [key]);
      } else if (selection.name === 'repository') {
        const args = argsOf(selection, variables);
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        data[key] = repo ? selectFields('Repository', repoObject(store, repo), selection.selections, ctx, REPO_RESOLVERS, [key]) : null;
      } else if (selection.name === 'node') {
        const args = argsOf(selection, variables);
        const resolved = store.resolveGlobalId(String(args.id ?? ''));
        if (!resolved || resolved.kind !== 'repo') {
          data[key] = null;
        } else {
          data[key] = selectFields('Repository', repoObject(store, resolved.repo), selection.selections, ctx, REPO_RESOLVERS, [key]);
        }
      } else if (selection.name === '__type') {
        const args = argsOf(selection, variables);
        const typeName = String(args.name ?? '');
        if (!(typeName in SCHEMA_FIELDS) && typeName !== 'SearchType') {
          data[key] = null;
        } else {
          data[key] = selectFields('__Type', { __typename: '__Type', name: typeName }, selection.selections, ctx, TYPE_RESOLVERS, [key]);
        }
      } else {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".`, path: [key] });
      }
    }
  } else {
    // mutation
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') continue;
      const key = selection.alias ?? selection.name;
      const args = argsOf(selection, variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (selection.name === 'createIssue') {
        const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
        if (!resolved || resolved.kind !== 'repo') {
          ctx.errors.push({ message: 'createIssue: repository not found', path: [key] });
          data[key] = null;
          continue;
        }
        const issue = store.createIssue(resolved.repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        const payload = { __typename: 'CreateIssuePayload', issue: selectFields('Issue', issueObject(store, resolved.repo, issue), selectionsFor(selection.selections, 'issue'), ctx, ISSUE_RESOLVERS, [key, 'issue']) };
        data[key] = selectFields('CreateIssuePayload', payload, selection.selections, ctx, { issue: (s) => scalar((s as Record<string, unknown>).issue) }, [key]);
      } else if (selection.name === 'closeIssue') {
        const resolved = store.resolveGlobalId(String(input.issueId ?? ''));
        if (!resolved || resolved.kind !== 'issue' || !resolved.issue) {
          ctx.errors.push({ message: 'closeIssue: issue not found', path: [key] });
          data[key] = null;
          continue;
        }
        resolved.issue.state = 'closed';
        resolved.repo.version += 1;
        const payload = { __typename: 'CloseIssuePayload', issue: selectFields('Issue', issueObject(store, resolved.repo, resolved.issue), selectionsFor(selection.selections, 'issue'), ctx, ISSUE_RESOLVERS, [key, 'issue']) };
        data[key] = selectFields('CloseIssuePayload', payload, selection.selections, ctx, { issue: (s) => scalar((s as Record<string, unknown>).issue) }, [key]);
      } else if (selection.name === 'createPullRequest') {
        const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
        if (!resolved || resolved.kind !== 'repo') {
          ctx.errors.push({ message: 'createPullRequest: repository not found', path: [key] });
          data[key] = null;
          continue;
        }
        const repo = resolved.repo;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'createPullRequest: head or base branch not found', path: [key] });
          data[key] = null;
          continue;
        }
        const pull = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
        const payload = { __typename: 'CreatePullRequestPayload', pullRequest: selectFields('PullRequest', pullObject(store, repo, pull), selectionsFor(selection.selections, 'pullRequest'), ctx, PULL_RESOLVERS, [key, 'pullRequest']) };
        data[key] = selectFields('CreatePullRequestPayload', payload, selection.selections, ctx, { pullRequest: (s) => scalar((s as Record<string, unknown>).pullRequest) }, [key]);
      } else if (selection.name === 'mergePullRequest') {
        const resolved = store.resolveGlobalId(String(input.pullRequestId ?? ''));
        if (!resolved || resolved.kind !== 'pull' || !resolved.pull) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found', path: [key] });
          data[key] = null;
          continue;
        }
        const repo = resolved.repo;
        const pull = resolved.pull;
        if (pull.state === 'closed') {
          ctx.errors.push({ message: 'mergePullRequest: pull request is already closed', path: [key] });
          data[key] = null;
          continue;
        }
        const merged = store.mergePull(repo, pull);
        if (merged === null) {
          ctx.errors.push({ message: 'mergePullRequest: merge conflict', path: [key] });
          data[key] = null;
          continue;
        }
        const payload = { __typename: 'MergePullRequestPayload', pullRequest: selectFields('PullRequest', pullObject(store, repo, pull), selectionsFor(selection.selections, 'pullRequest'), ctx, PULL_RESOLVERS, [key, 'pullRequest']) };
        data[key] = selectFields('MergePullRequestPayload', payload, selection.selections, ctx, { pullRequest: (s) => scalar((s as Record<string, unknown>).pullRequest) }, [key]);
      } else if (selection.name === 'addComment') {
        const resolved = store.resolveGlobalId(String(input.subjectId ?? ''));
        if (!resolved || (resolved.kind !== 'issue' && resolved.kind !== 'pull') || (!resolved.issue && !resolved.pull)) {
          ctx.errors.push({ message: 'addComment: subject not found', path: [key] });
          data[key] = null;
          continue;
        }
        const repo = resolved.repo;
        const body = String(input.body ?? '');
        let comment: { id: number; body: string };
        if (resolved.kind === 'issue' && resolved.issue) {
          comment = store.createComment(repo, resolved.issue, body);
        } else {
          // A comment on a pull request: it lives on the pull request itself.
          comment = store.createPullComment(repo, resolved.pull!, body);
        }
        const node = { __typename: 'IssueComment', id: store.commentGlobalId(repo, comment), body };
        const edge = { __typename: 'IssueCommentEdge', node: selectFields('IssueComment', node, selectionsFor(selectionsFor(selection.selections, 'commentEdge'), 'node'), ctx, { id: (s) => scalar((s as Record<string, unknown>).id), body: (s) => scalar((s as Record<string, unknown>).body) }, [key, 'commentEdge', 'node']) };
        const payload = { __typename: 'AddCommentPayload', commentEdge: selectFields('IssueCommentEdge', edge, selectionsFor(selection.selections, 'commentEdge'), ctx, { node: (s) => scalar((s as Record<string, unknown>).node) }, [key, 'commentEdge']) };
        data[key] = selectFields('AddCommentPayload', payload, selection.selections, ctx, { commentEdge: (s) => scalar((s as Record<string, unknown>).commentEdge) }, [key]);
      } else {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".`, path: [key] });
      }
    }
  }
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOne(store: Store, body: unknown): { data: Record<string, unknown> | null; errors: GqlError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL body must be an object with a query string' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL query must be a non-empty string' }] };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'GraphQL document has no operations' }] };
  const operationName = (body as Record<string, unknown>).operationName;
  let operation = operations[0];
  if (typeof operationName === 'string' && operationName !== '') {
    const named = operations.find((entry) => entry.name === operationName);
    if (named) operation = named;
  }
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (vars[variable.name] === undefined && variable.defaultValue !== null) {
      vars[variable.name] = valueOf(variable.defaultValue, vars);
    }
  }
  return executeOperation(store, operation, vars);
}

/** POST /api/graphql. A JSON array body is GitHub's operation batching: answer an array. */
export function handleGraphQL(store: Store, bodyText: string): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'GraphQL body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne(store, entry));
    return { status: 200, body: results.map((result) => (result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data })) };
  }
  const result = executeOne(store, parsed);
  return { status: 200, body: result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data } };
}
