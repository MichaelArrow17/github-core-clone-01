# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/MichaelArrow17/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/MichaelArrow17/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for the make.fun bounty **"Build a GitHub-compatible git forge"**
(`github-core-clone-01`, $500). A standalone GitHub-compatible git forge in
**one Node process**, no UI, no external services, no git binary. It serves,
from its own in-memory store:

- **git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen,
  `thin-pack`, `ofs-delta`) plus v0 `upload-pack` fallback and v0
  `receive-pack` (fast-forward validation, `report-status-v2`,
  `side-band-64k`, `delete-refs`). The whole pack protocol — pkt-line
  framing, PACK v2 read/write, SHA-1 object store, OFS/REF delta resolution —
  is implemented natively in TypeScript (`gitcodec.ts`, `gitproto.ts`) using
  only the Node standard library. Nothing shells out to `git`.
- **REST v3** under `/api/v3` — repos, contents, labels, issues, comments,
  refs, branches, commits, pulls (with squash merge).
- **GraphQL** at `/api/graphql` — repository / issue / pull request queries,
  mutations (`createPullRequest`, `addComment`), Relay-style opaque global
  ids, `node(id:)` round-trips, cursor pagination, introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (revision
  2026-07-28 plus legacy handshake): `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`
(`POST {"port": N}`) and polls `$MAKEFUN_ENV_URL/done` until the trial is
done. `MAKEFUN_SHOP_TOKEN`, when set, must match the `Authorization: Bearer`
token on every request; otherwise any non-empty bearer token is accepted.
The server answers `/healthz` with `200 {"ok": true}`.

## Files

| File | What it does |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll `/done`, exit (kit starter, unchanged). |
| `app.ts` | HTTP routing: `/healthz`, `/api/graphql`, `/mcp`, `/{owner}/{repo}.git/*`, `/api/v3/*`. Auth, JSON envelope, `X-GitHub-Request-Id`. |
| `store.ts` | In-memory state: repos, objects, refs, issues, PRs, labels, comments; deterministic server commits; 3-way merge; squash merge; pack cache. |
| `gitcodec.ts` | SHA-1 hashing, pkt-line codec, tree/commit/tag parse/build, reachability, fetch object-set computation, PACK v2 write/read with delta resolution. |
| `gitproto.ts` | Smart-HTTP wire protocol: info/refs (v2/v0), `ls-refs`, `fetch` v2/v0, `receive-pack` with per-ref fast-forward validation. |
| `rest.ts` | All REST v3 routes. |
| `graphql.ts` | Hand-rolled GraphQL tokenizer/parser + fixed schema + resolvers. |
| `mcp.ts` | MCP JSON-RPC: `server/discover`, `initialize`, `ping`, `tools/list`, `tools/call`. |

## Determinism

Server-generated commits (contents PUTs, merges) use a fixed identity and
counter-based timestamps, so two runs on the same instance leave the same
state export byte for byte.

## License

MIT. See `LICENSE`.
