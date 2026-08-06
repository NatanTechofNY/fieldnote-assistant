# AGENTS.md

Instructions for AI coding agents working on this repository. This is not documentation for
Fieldnote's own assistant — for that, see [`docs/AGENT_STUDIO_SETUP.md`](docs/AGENT_STUDIO_SETUP.md).

## Setup and checks

Node.js 22 (see `.nvmrc`). `cp .env.example .env && npm install`, then `npm run dev` for the UI on
`4173` and the API on `4174`. Algolia credentials are optional; without them the app runs in local
mode and search falls back to a SQLite `LIKE` scan.

Before considering a change done:

```bash
npm run lint
npm run typecheck
npm test
```

## Invariants

These are the things that break quietly. Read
[`docs/ARCHITECTURE_AND_DATA_FLOW.md`](docs/ARCHITECTURE_AND_DATA_FLOW.md) before non-trivial
server work.

**SQLite is the source of truth and Algolia holds derived projections.** Any code path that writes
an indexed entity must also call `queueIndexJob(db, entity, id)` from `server/db.ts`, with a
`"delete"` op on removal. Missing the enqueue leaves search silently stale; reindexing is always
safe to repeat.

**The reminder worker assumes exactly one writer.** Introducing a second concurrent writer to the
database is a correctness bug, not a performance tradeoff. This is also why the app deploys as a
single replica.

**Routes are auth-gated by registration order.** `server/routes/auth.ts` is registered first, so
anything mounted after it is protected by default. Only `/api/health` and `/api/webhooks/*` are
exempt, in the check at the top of that file. Adding a public route means editing that exemption
deliberately — think about what it hands an unauthenticated caller.

**Agent tools bypass the REST API.** They execute in `server/tool-executor.ts`, reached from the
browser via `POST /api/agent/tools/:name` and called in-process by the SMS worker. A behavior
change usually has to land in both the tool executor and the matching REST route.
[`docs/TOOL_ENDPOINT_MAPPING.md`](docs/TOOL_ENDPOINT_MAPPING.md) maps the pairs.

**Tool schemas are contract-tested.** `tests/server-api.test.ts` asserts that the tools published
in `agent-studio/tools/client-tools.json` are exactly the keys of `toolInput` in
`server/schemas.ts`, that each is `additionalProperties: false`, and that the tool count matches.
Adding or renaming a tool means updating all three plus the count assertion in the test.

## Boundaries

`internal/` is gitignored talk and presentation material. Do not edit it and do not cite it as
documentation — `docs/` and the README are the published sources.

Never commit `.env` (only `.env.example`), anything under `data/` or `server/data/`, or any
`*.db` / `*.sqlite` file. `npm run seed` generates exactly these.

## Conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): description`, using `fix`, `feat`, `refactor`, `docs`, `test`, or `chore`.

When a change alters behavior described in `docs/` or the README, update it in the same change.
