# Deploying Fieldnote as a single service

## Why one container is enough

Fieldnote is already a single Node process. `npm start` runs one Express server that:

- serves the built React bundle from `dist/`
- serves the JSON API under `/api`
- receives Twilio and Sendblue webhooks at `/api/webhooks/*`
- runs the reminder, digest, and integration worker on an in-process timer

There is no separate frontend host, database service, or cron service to deploy. The whole system is one container plus one persistent volume.

Schema migrations are not a deploy step. `openDatabase()` applies the canonical schema and every incremental migration each time the database is opened, which includes every server start and every CLI command.

The `Dockerfile` is multi-stage on `node:22-bookworm-slim`: the build stage installs `python3`, `make`, and `g++` to compile `better-sqlite3`, runs `npm ci` and `npm run build`, then prunes dev dependencies; the runtime stage copies `dist/`, `server/`, `agent-studio/`, and the tsconfigs, exposes `4174`, declares `VOLUME ["/data"]`, and starts the server with `node --import tsx server/index.ts`. That is the same process `npm start` runs, invoked directly so that the platform's `SIGTERM` reaches the shutdown handler instead of being absorbed by npm.

External dependencies are all outbound HTTPS, so nothing else needs to be deployed or exposed. The container calls Algolia, whichever message provider is selected (Twilio or Sendblue), Granola, and — once Atlassian is connected — your Atlassian site. A host that restricts egress needs `*.atlassian.net` allowed alongside the Algolia and message provider endpoints; digest briefs make those calls from the worker, so a blocked egress rule surfaces as a failed brief rather than a failed request.

## Hard constraints

SQLite owns reminders, delivery attempts, channel history, and integration cursors, which forces three rules:

1. **One replica.** Two writers on the same SQLite file will corrupt state and double-send reminders and digest briefs, because the once-per-day send is claimed by a row in that file.
2. **A real persistent volume.** Container filesystems reset on deploy. Mount a volume and point `DATABASE_PATH` at it.
3. **No scale-to-zero.** The worker must stay resident to fire scheduled reminders and digests.

Railway, Fly.io, Render with a paid disk, or any VPS running Docker all satisfy these. Serverless platforms do not; see [Platforms that do not work](#platforms-that-do-not-work).

## Railway (recommended)

`railway.json` in the repository root already pins the Dockerfile builder, one replica, the `/api/health` health check, and a required `/data` mount, so a deploy fails loudly instead of silently losing the database.

1. Create a Railway project from this repository. Railway reads `railway.json` and builds the `Dockerfile`.
2. Add a volume mounted at `/data`.
3. Set the variables listed in [Required variables](#required-variables).
4. Generate a public domain for the service.
5. Deploy, then open `/settings`, enter the public URL, and select **Connect & configure** so Twilio webhooks point at the deployed origin.

The image defaults `DATABASE_PATH` to `/data/assistant.db`, so no override is needed when the volume is mounted at `/data`.

## Any Docker host

```bash
docker build -t fieldnote .
docker volume create fieldnote-data

docker run -d --name fieldnote \
  -p 4174:4174 \
  -v fieldnote-data:/data \
  --env-file .env.production \
  --restart unless-stopped \
  fieldnote
```

Put a TLS-terminating reverse proxy in front of it. Twilio requires HTTPS and validates its signature against the exact public URL.

## Cloudflare Tunnel

Cloudflare Tunnel is the one Cloudflare product that fits this app, and it needs no code changes. It is not a host: the container keeps running on a machine you control, with its real disk and always-on worker, and Cloudflare supplies a stable public HTTPS hostname plus WAF and DDoS protection. The `cloudflared` daemon dials out to Cloudflare, so no inbound ports need to be open.

Use a **named** tunnel on a domain you own:

```bash
cloudflared tunnel login
cloudflared tunnel create fieldnote
cloudflared tunnel route dns fieldnote assistant.example.com
sudo cloudflared service install <TUNNEL_TOKEN>
```

Map the hostname to `http://localhost:4174`, then set that same origin as the webhook base URL on the Settings page so Twilio signature validation matches the URL Twilio signed.

Do not use a quick tunnel (`cloudflared tunnel --url`) for anything lasting. It mints a random `trycloudflare.com` hostname that changes on every restart, which silently breaks Twilio signature validation and forces you to reconfigure the webhook each time. Quick tunnels also cap concurrent requests and do not support Server-Sent Events.

`cloudflared` becomes a second process that must stay running. Install it as a system service rather than leaving it in a terminal, because a dead tunnel means Twilio webhooks fail while the app itself still looks healthy.

## Platforms that do not work

**Cloudflare Workers and Pages.** Workers run in a V8 isolate rather than a Node process, so the native `better-sqlite3` module cannot load at all — this is a deliberate sandboxing decision, not a missing feature. Their virtual filesystem is per-request and in-memory, and there is no way to keep a `setInterval` alive between invocations. Pages inherits every one of those constraints and additionally has no cron triggers. Running here would mean rewriting the storage layer onto Durable Object SQL or D1 and moving the scheduler to alarms or cron triggers, which is a rearchitecture rather than a deployment.

**Cloudflare Containers.** These will run the image fine — it is a real Linux VM, so Node, Express, and `better-sqlite3` all work. The problem is storage: Cloudflare documents that "all disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its container image." Instances sleep after inactivity and are relocated between hosts on an irregular cadence with no uptime guarantee. Every todo, memory, reminder, and integration cursor would be destroyed on each restart, silently and without an error. The `VOLUME` declaration in the `Dockerfile` does not help, because there is no volume to bind it to.

**Vercel and Netlify.** Ephemeral filesystems and no always-on process, for the same reasons.

## Build-time versus runtime variables

Server variables are read at runtime, so changing them only needs a restart. The four `VITE_*` values are different: Vite inlines them into the browser bundle during `npm run build`, so they must be present at **build** time. The `Dockerfile` declares all four as build args.

Railway exposes service variables to the build, so setting them in the dashboard is enough. With plain `docker build`, pass them explicitly:

```bash
docker build -t fieldnote \
  --build-arg VITE_ALGOLIA_APPLICATION_ID=... \
  --build-arg VITE_ALGOLIA_SEARCH_API_KEY=... \
  --build-arg VITE_ALGOLIA_AGENT_ID=... \
  --build-arg VITE_ALGOLIA_TODO_INDEX=devcon_assistant_todos \
  .
```

Only search-scoped Algolia values belong in `VITE_*`. Anything passed as a build argument ends up readable in the JavaScript bundle. **Never** pass the Algolia admin key, the Twilio auth token, `SETTINGS_ENCRYPTION_KEY`, or `APP_ADMIN_PASSWORD` this way. Omitting the `VITE_*` values is fine; the agent panel falls back to the server-proxied agent.

## Required variables

Set these as host secrets. Never commit them.

| Variable | Purpose |
|---|---|
| `SETTINGS_ENCRYPTION_KEY` | AES-256-GCM key protecting stored Twilio, Sendblue, Granola, and Atlassian secrets |
| `APP_ADMIN_PASSWORD` | Basic Auth password for the app and API; username is `admin` |
| `ALGOLIA_APPLICATION_ID` | Algolia application |
| `ALGOLIA_ADMIN_API_KEY` | Indexing from the server |
| `ALGOLIA_SEARCH_API_KEY` | Query-only key |
| `ALGOLIA_AGENT_ID` | Published Agent Studio agent |
| `ALGOLIA_AGENT_API_KEY` | Agent Studio access. Falls back to `ALGOLIA_SEARCH_API_KEY` when unset |

### Optional variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4174` | HTTP port |
| `DATABASE_PATH` | `./data/assistant.db`, `/data/assistant.db` in the image | SQLite file |
| `DEMO_USER_ID` | `devcon-demo` | The fixed identity every handler binds to. Changing it after data exists orphans that data, and the checked-in search-tool filter still pins `devcon-demo` |
| `APP_ALLOW_NO_AUTH` | `false` | Lets the server start in production with no password at all. Rarely correct |
| `CORS_ORIGIN` | `http://localhost:4173` | Only needed when the UI is served from a different origin than the API |
| `ALGOLIA_TODO_INDEX` | `devcon_assistant_todos` | Index name |
| `ALGOLIA_MEMORY_INDEX` | `devcon_assistant_memories` | Index name |
| `ALGOLIA_MESSAGE_INDEX` | `devcon_assistant_messages` | Index name |
| `ALGOLIA_NEURAL_SEARCH` | `false` | Initial NeuralSearch value for a **fresh** database only. After that the Settings toggle owns it |
| `VITE_ALGOLIA_*` | unset | Build-time browser values, see above |

Three exist for development only and should never be set in production: `TWILIO_SKIP_SIGNATURE_VALIDATION` and `SENDBLUE_SKIP_SIGNATURE_VALIDATION` (both ignored when `NODE_ENV=production`) and `VITE_ALLOWED_HOSTS` (tunnel hostnames for the Vite dev server on 4173).

Generate the two local secrets with:

```bash
openssl rand -base64 32   # SETTINGS_ENCRYPTION_KEY
openssl rand -base64 24   # APP_ADMIN_PASSWORD
```

`SETTINGS_ENCRYPTION_KEY` must be backed up separately from the database. Losing it makes saved integration credentials unreadable, and rotating it requires reconnecting Twilio, Sendblue, Granola, and Atlassian. Restore the volume and the key together.

Atlassian needs no environment variable of its own: the site URL, account email, and API token are entered on the Integrations page and stored encrypted in SQLite under this key. Atlassian API tokens expire after a year, so a brief that suddenly reports an authentication failure usually needs a new token rather than a redeploy.

`APP_ADMIN_PASSWORD` is the only thing standing between the public internet and your personal data, because health checks and provider webhooks intentionally bypass it. The server refuses to start in production without it. Browsers sign in at `/login` and get a session cookie; scripts can still use Basic Auth with the username `admin`.

Over plain HTTP the password and session cookie travel in the clear, so a deployment reachable beyond your own network needs TLS in front of it. On a LAN-only install this matters less, but the session cookie will not be marked `Secure` until the app is served over HTTPS.

## After the first deploy

Three steps, none of which are automatic:

```bash
npm run setup:algolia   # apply agent-studio/indices/*.settings.json in the current search mode
npm run reindex         # rebuild all three indices from SQLite via replaceAllObjects
```

Then **publish the agent configuration**, which is easy to forget because nothing fails loudly without it — the agent just runs whatever was last published. Use the sync button in Settings → Under the hood, or `POST /api/admin/agent-studio/sync-tools`. That pushes `client-tools.json`, `algolia-search.json`, `system-prompt.txt`, and `system-prompt-block.txt` to Agent Studio and publishes the result.

The first two also have admin equivalents, `POST /api/admin/algolia/setup` and `POST /api/admin/reindex`, so you can run them from the deployed UI instead of a shell. Algolia holds only derived projections, so reindexing is always safe to repeat.

`npm run seed` adds presentation-safe sample data and `npm run reset` restores the known demo dataset. Neither is needed for a real deployment.

## Health checks

`GET /api/health` deliberately answers differently depending on who is asking, because it is the one route that bypasses authentication:

- **Unauthenticated** (platform probes, the Docker `HEALTHCHECK`, Railway): `{ "success": true, "data": { "ok": true } }`. Liveness only — no index names, record counts, or agent ID.
- **Authenticated**: SQLite record counts, Algolia reachability, Agent Studio configuration, the resolved index names, the NeuralSearch toggle state, and the pending index-job count.

So a probe returning a bare `ok` is correct, not a degraded response. Sign in to see the real diagnostics.
