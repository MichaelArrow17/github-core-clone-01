// gitproto.ts — the git smart-HTTP surface: info/refs advertisements (v0 and v2), v2 ls-refs
// and fetch, v0 fetch, and v0 receive-pack (push). All object ids and bytes come from the
// store; the pack writer emits plain (undeltified) packs.

import {
  PKT_LINE_MAX_PAYLOAD,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  decodePktLinesStrict,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  objectsForFetch,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  type DecodedPacket,
  type GitObject,
} from './gitcodec.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN, type Repo, type Store } from './store.ts';

export const AGENT = 'github-core-clone/1.0.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): HttpResult {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** One sideband frame: a pkt-line carrying band byte + data (data chunked to the pkt-line max). */
function sidebandFrames(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxData));
    frames.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return frames;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** The refs a repo advertises, in git's order (HEAD handled by the caller). */
function refLines(store: Store, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  for (const { name, oid } of store.sortedRefs(repo)) {
    const line: RefLine = { name, oid };
    const peeled = store.peeledTarget(repo, oid);
    if (peeled !== undefined) line.peeled = peeled;
    lines.push(line);
  }
  return lines;
}

/** The v0 capability list for a service, as one space-separated string. */
function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k ofs-delta agent=${AGENT}`;
  if (service === 'git-upload-pack') return `${common} shallow`;
  return `report-status-v2 report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — the advertisement. Upload-pack answers v2 when
 * the request carries `Git-Protocol: version=2`, else v0; receive-pack is v0-only. A missing
 * repository is a 404 and the server stays up.
 */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, query: URLSearchParams, headers: Record<string, string | undefined>): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return httpError(404, 'Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return httpError(400, 'unknown service');
  const wantsV2 = service === 'git-upload-pack' && (headers['git-protocol'] ?? '') === 'version=2';

  if (wantsV2) {
    const lines: Array<string | 'flush'> = [
      `# service=${service}\n`,
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'object-format=sha1\n',
      `agent=${AGENT}\n`,
      'flush',
    ];
    return ok(UPLOAD_AD, encodePktLines(lines));
  }

  // v0 advertisement: preamble, then "<oid> <ref>" lines, capabilities after NUL on the first line.
  const caps = v0Capabilities(service);
  const refs = refLines(store, repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      if (ref.name === 'HEAD') continue;
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return ok(service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, encodePktLines(lines));
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: readonly DecodedPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command=ls-refs, agent=, object-format= live before the delim
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(store: Store, repo: Repo, packets: readonly DecodedPacket[]): HttpResult {
  const args = parseLsRefsArgs(packets);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (args.symrefs && keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of refLines(store, repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return ok(UPLOAD_RESULT, encodePktLines(lines));
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseV2FetchArgs(packets: readonly DecodedPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

function parseV0FetchArgs(packets: readonly DecodedPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

/** The pack to send for a fetch, with the shallow boundary the client should record. */
function computeFetchPack(store: Store, repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const cacheKey = `${repo.version}|${[...args.wants].sort().join(',')}|${args.depth ?? ''}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    return { pack: cached.pack, shallow: cached.shallow, unshallow: args.shallow.filter((oid) => !cached.shallow.includes(oid)) };
  }
  const { objects, shallow } = objectsForFetch(args.wants, args.haves, args.depth, store.lookup(repo), args.shallow);
  const pack = writePack(objects);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, { pack, shallow });
  return { pack, shallow, unshallow: args.shallow.filter((oid) => !shallow.includes(oid)) };
}

function handleFetchV2(store: Store, repo: Repo, packets: readonly DecodedPacket[]): HttpResult {
  const args = parseV2FetchArgs(packets);
  const { pack, shallow, unshallow } = computeFetchPack(store, repo, args);
  const parts: Buffer[] = [];
  // acknowledgments
  if (args.haves.length > 0) {
    const acks: string[] = [];
    for (const have of args.haves) {
      // A have is common when it is an ancestor of a want (or a want itself) and the server holds it.
      if (!repo.objects.has(have)) continue;
      const common = args.wants.some((want) => store.isAncestor(repo, have, want));
      if (common) acks.push(have);
    }
    parts.push(encodePktLines(['acknowledgments\n', ...(acks.length ? [...acks.map((oid) => `ACK ${oid}\n` as const), 'ready\n' as const] : ['NAK\n' as const]), 'delim']));
  }
  // shallow-info
  if (args.depth !== null) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  // packfile
  const packParts: Buffer[] = [encodePktLine('packfile\n'), ...sidebandFrames(pack)];
  parts.push(Buffer.concat([...packParts, Buffer.from('0000', 'ascii')]));
  return ok(UPLOAD_RESULT, Buffer.concat(parts));
}

function handleFetchV0(store: Store, repo: Repo, packets: readonly DecodedPacket[]): HttpResult {
  const args = parseV0FetchArgs(packets);
  const { pack, shallow, unshallow } = computeFetchPack(store, repo, args);
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of args.haves) {
    if (!repo.objects.has(have)) continue;
    if (args.wants.some((want) => store.isAncestor(repo, have, want))) acks.push(have);
  }
  const control: string[] = [];
  if (acks.length) for (const oid of acks) control.push(`ACK ${oid}\n`);
  else control.push('NAK\n');
  for (const oid of shallow) control.push(`shallow ${oid}\n`);
  for (const oid of unshallow) control.push(`unshallow ${oid}\n`);
  if (control.length) parts.push(encodePktLines(control));
  parts.push(Buffer.concat([...sidebandFrames(pack), Buffer.from('0000', 'ascii')]));
  return ok(UPLOAD_RESULT, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): HttpResult {
  // The command list is pkt-lines up to the first flush; the rest is the raw packfile.
  let packets: DecodedPacket[];
  let consumed = 0;
  try {
    const decoded = decodePktLines(body);
    packets = decoded.packets;
    consumed = decoded.consumed;
  } catch (err) {
    return httpError(400, `malformed pkt-line stream: ${(err as Error).message}`);
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (commands.length === 0) capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      return httpError(400, `malformed push command ${JSON.stringify(line.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return httpError(400, 'push with no commands');

  const packBytes = body.subarray(consumed);
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (hasPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        const read = readPack(packBytes, { resolveBase: store.lookup(repo) });
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
  }

  const outcomes: PushOutcome[] = [];
  if (unpackError === null) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          outcomes.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          outcomes.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
        } else {
          repo.refs.delete(command.ref);
          outcomes.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // create or update: the new object must be in the store now
      if (!repo.objects.has(command.newOid)) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          outcomes.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          outcomes.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === undefined) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (command.oldOid !== current) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (command.newOid === current) {
        outcomes.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (outcomes.some((outcome) => outcome.ok)) {
      repo.version += 1;
      repo.packCache.clear();
    }
  }

  // The report-status stream, pkt-lined inside sideband band 1.
  const reportLines: string[] = [];
  if (unpackError !== null) reportLines.push(`unpack error ${unpackError}\n`);
  else {
    reportLines.push('unpack ok\n');
    for (const outcome of outcomes) {
      reportLines.push(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`);
    }
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const frames: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < inner.length; offset += maxData) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + maxData));
    frames.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  frames.push(Buffer.from('0000', 'ascii'));
  return ok(RECEIVE_RESULT, Buffer.concat(frames));
}

// ---------------------------------------------------------------------------------------------
// entry point for POST /{owner}/{repo}.git/git-upload-pack | git-receive-pack
// ---------------------------------------------------------------------------------------------

export function handleGitPost(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  body: Buffer,
  headers: Record<string, string | undefined>,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return httpError(404, 'Not Found');
  if (service === 'git-receive-pack') return handleReceivePack(store, repo, body);
  if (service !== 'git-upload-pack') return httpError(400, 'unknown service');

  let packets: DecodedPacket[];
  try {
    packets = decodePktLinesStrict(body);
  } catch (err) {
    return httpError(400, `malformed pkt-line stream: ${(err as Error).message}`);
  }
  // v2 when the Git-Protocol header says so (or the first line is a v2 command).
  const firstLine =
    packets.find((packet) => packet.kind === 'data')?.kind === 'data'
      ? (packets.find((packet) => packet.kind === 'data') as { kind: 'data'; payload: Buffer }).payload.toString('utf8')
      : '';
  const isV2 = (headers['git-protocol'] ?? '') === 'version=2' || firstLine.startsWith('command=');
  if (!isV2) return handleFetchV0(store, repo, packets);
  if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(store, repo, packets);
  if (firstLine.startsWith('command=fetch')) return handleFetchV2(store, repo, packets);
  return httpError(400, `unknown upload-pack command ${JSON.stringify(firstLine.slice(0, 40))}`);
}

/** Parse an annotated tag object the store holds (for the peeled advertisement). */
export function tagTarget(store: Store, repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

export { VIEWER_LOGIN, collectReachable, hashObject };
