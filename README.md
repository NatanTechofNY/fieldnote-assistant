# Fieldnote

**A local-first personal AI assistant that keeps your data in SQLite and uses Algolia for semantic retrieval.**

[![CI](https://github.com/NatanTechofNY/fieldnote-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/NatanTechofNY/fieldnote-assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22-brightgreen.svg)](.nvmrc)

> [!IMPORTANT]
> This is a personal demo project built for a conference talk. It is **not an official Algolia product**, is not affiliated with or endorsed by Algolia, Twilio, Sendblue, or Granola, and carries no SLA or support guarantee. It is provided "as is". Read [SECURITY.md](SECURITY.md) before exposing an instance to the internet.

## What it does

Fieldnote is a personal assistant you actually own. It tracks todos, memories, conversations, and reminders, and can reach you over SMS. Everything lives in a SQLite file on disk that you control.

The interesting part is the split of responsibilities. **SQLite is the source of truth** for all state. **Algolia stores searchable projections** of that data, optionally with hybrid semantic retrieval through NeuralSearch, so asking "what did I decide about the pricing work?" finds the right note without exact keyword matches. **Agent Studio decides** when to search and when to call the app's typed action tools, so the assistant can create a todo or send a reminder rather than only answering questions.

Because Algolia holds only derived projections, reindexing is always safe to repeat and losing the index never loses your data.

## Features

- Todos, memories, conversations, and reminders backed by local SQLite
- Full-text search over your own notes via Algolia, with an optional NeuralSearch toggle for hybrid semantic retrieval (off by default, since it is a paid add-on)
- An agent that calls typed action tools, executed server-side
- Two-way messaging through Twilio SMS or Sendblue iMessage, switchable from Settings, with quiet hours, daily digests, and retry with backoff
- Granola meeting-note polling with a manual review queue
- Read-only Jira and Confluence lookups, plus digest briefs: an instruction of your own that the agent runs on its own schedule and texts you, previewable from Settings before it ever sends
- Runs without Algolia credentials in local mode: all CRUD works and conversation search falls back to SQLite, though the agent and NeuralSearch need credentials
- Password-protected sign-in with sessions, so a self-hosted instance is not wide open

## Architecture

The whole app is a single Node process. One Express server serves the built React bundle, the JSON API, the message provider webhooks, and an in-process worker that fires every minute for reminders and digests. There is no separate frontend host, database service, or cron service.

```
Browser  ─┐
          ├──▶ Express (single process) ──▶ SQLite  (source of truth)
Twilio or │         │                            │
Sendblue ─┘         │                            │
                    │                            └──▶ index jobs
                    └──▶ Algolia NeuralSearch ◀────────────┘
                         + Agent Studio
```

[`docs/ARCHITECTURE_AND_DATA_FLOW.md`](docs/ARCHITECTURE_AND_DATA_FLOW.md) has the detail.

## Getting started

Requires Node.js 22 (see [`.nvmrc`](.nvmrc)).

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). The API runs on port `4174`.

Press `⌘K` (`Ctrl+K`) for universal search across memories, todos, and conversation history, and `⌘I` (`Ctrl+I`) to open the agent panel from any page.

Without Algolia credentials the app still runs: todos, memories, reminders, and conversation history all work against SQLite, and universal search, memory search, and conversation search each fall back to a SQLite `LIKE` scan. The agent panel serves a small deterministic fallback assistant rather than Agent Studio. To enable semantic search and the real agent, fill in the Algolia values in `.env` and run:

```bash
npm run seed
npm run setup:algolia
npm run reindex
```

The server reads `ALGOLIA_APPLICATION_ID`, `ALGOLIA_ADMIN_API_KEY` (writes and index settings), `ALGOLIA_SEARCH_API_KEY` (reads), `ALGOLIA_AGENT_ID`, and `ALGOLIA_AGENT_API_KEY` (falls back to the search key if unset). The browser bundle needs its own `VITE_ALGOLIA_*` copies, which are baked in at build time. `.env.example` lists every variable with notes.

Then configure and publish the Agent Studio agent using the artifacts in [`agent-studio/`](agent-studio/), following [`docs/AGENT_STUDIO_SETUP.md`](docs/AGENT_STUDIO_SETUP.md).

## SMS and integrations

The **Settings** page (`/settings`) configures encrypted Twilio and Sendblue credentials, which of the two carries outbound messages, reminder delivery, daily digests, quiet hours, Granola meeting-note polling, and Atlassian credentials. Both providers can stay connected, and inbound messages are answered on whichever one they arrive on. Inbound handling is entirely server-side — the worker runs the agent loop and executes its tools in-process — so no browser needs to be open for a reminder to send or a text to get answered.

See [`docs/SMS_AND_EVENTS.md`](docs/SMS_AND_EVENTS.md) for tunnels, provider consent requirements, and recovery.

## Deployment

The entire app deploys as one container plus one persistent volume for SQLite. A [`Dockerfile`](Dockerfile) and [`railway.json`](railway.json) are included.

SQLite forces three rules: exactly one replica, a real persistent volume, and no scale-to-zero. That makes serverless platforms unsuitable — notably Cloudflare Containers, whose disk is ephemeral and would silently discard your database on every restart. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers Railway, any Docker host, Cloudflare Tunnel for a stable public URL, and why the other options fail.

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Run the Vite UI and local API |
| `npm start` | Run the production server, serving `dist/` |
| `npm run build` | Typecheck and create a production bundle |
| `npm test` | Run backend and frontend tests |
| `npm run lint` | Lint the project |
| `npm run seed` | Add presentation-safe sample data |
| `npm run reset` | Restore the known demo dataset |
| `npm run setup:algolia` | Apply index settings in the currently selected search mode |
| `npm run reindex` | Rebuild Algolia from SQLite |

## Documentation

- [Architecture and data flow](docs/ARCHITECTURE_AND_DATA_FLOW.md)
- [Agent Studio setup](docs/AGENT_STUDIO_SETUP.md)
- [Tool endpoint mapping](docs/TOOL_ENDPOINT_MAPPING.md)
- [SMS, reminders, and event integrations](docs/SMS_AND_EVENTS.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Troubleshooting and security](docs/TROUBLESHOOTING_SECURITY.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and checks, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Author

- Natan Yagudayev ([@NatanTechofNY](https://github.com/NatanTechofNY))

## License

[MIT](LICENSE)

No existing application, database, phone integration, or production account is used by this project.
