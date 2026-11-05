# Alexa

Fieldnote and Alexa connect in two directions, and they are separate: neither needs the other, they trust different things, and
they fail in different ways.

| | Alexa+ → Fieldnote | Fieldnote → Alexa |
|---|---|---|
| What it does | An Echo reads and adds to the **Household** list: agenda, tasks, reminders | The assistant switches lights and plugs, runs routines and speaks on an Echo |
| Who calls whom | Alexa+ is the MCP client; Fieldnote serves MCP at `/mcp` | Fieldnote is the MCP client of the community [`alexa-mcp`](https://github.com/m0nkmaster/alexa-mcp) server |
| Whose records | One life area, `Household`, and nothing else | The owner's devices; owner's own chat only |
| Support | Amazon's published Alexa+ MCP Toolkit | **Unofficial.** Amazon has no supported API for this; it drives Alexa's private one |
| Settings | **Settings → Connections → Alexa** shows the link and unlinks it | Same card shows whether Amazon accepts the sign-in |

## Alexa+ → Fieldnote

### What an Echo can reach

An Echo is treated the way a group chat is: scoped to one life area and refused everything owner-only. The first call creates a
`Household` life area and a stand-in thread whose address is `alexa:household`. That address has no `group:` prefix on purpose, so
nobody can text it, and the worker treats it as a voice thread (`isVoiceThread`), so its overnight profile refresh is skipped. It is sent no check-in (those go
only to a sending group, which this is not), and nothing in it can create a page, because the page tools are not voice tools.

The MCP server in [`server/alexa-mcp-server.ts`](../server/alexa-mcp-server.ts) publishes eight tools, each running through
`executeAgentTool()` with a context that carries `scope` (the Household) and `surface: "voice"`:

`get_agenda`, `list_todos`, `get_todo`, `create_todo`, `set_todo_status`, `add_todo_comment`, `create_reminder`, `list_reminders`.

Three layers keep it there. The server registers only those eight. The executor refuses a voice turn with no scope, and refuses any
tool outside `VOICE_TOOLS` (`… is not available by voice`), so a new tool is unreachable from an Echo until it is added to that
set on purpose. And every by-id read and every list goes through the same scoping as a group chat (`scopedTodo`, `scopedMemory`),
so a todo ID from your Work area answers "not found". Memories, conversations, Jira, Confluence, pages, the web, and every device
tool are out of reach. There is no delete.

Times are the household's local wall clock with no offset (`2026-11-06T16:00`), converted with the owner's timezone on the
server. Tool descriptions are static for that reason: Alexa+ reads them only when you run `alexa-ai deploy`.

A reminder made from an Echo belongs to a Household todo, and the Household thread is not a group, so it is **texted to the owner's
own number**, like any non-group reminder. Alexa itself never speaks it.

### Setup

You need a public HTTPS address (`PUBLIC_BASE_URL`, or a Cloudflare Tunnel — see [`DEPLOYMENT.md`](DEPLOYMENT.md)) and
`APP_ADMIN_PASSWORD`. Without a password the consent page refuses with a 503: nothing else would stop anyone approving a link.

1. In `.env`, choose a client id and a long random secret:

   ```bash
   ALEXA_OAUTH_CLIENT_ID=fieldnote-alexa
   ALEXA_OAUTH_CLIENT_SECRET=$(openssl rand -base64 36)
   ```

   Restart the server. `GET /.well-known/oauth-authorization-server` should now answer (it is a 404 while unconfigured).

2. In [`alexa/addon-package/addon.json`](../alexa/addon-package/addon.json), replace every `fieldnote.example.com` with your host.
   **These are placeholders, and Fieldnote does not serve them:** the privacy and terms pages and the six icon sizes and the
   carousel image are yours to host at those URLs, and Amazon validates them.

3. With the Alexa AI CLI (`alexa-ai`, from Amazon's Alexa+ toolkit), authenticate and create the MCP integration, then link the
   account to the OAuth client you just made:

   ```bash
   alexa-ai configure
   alexa-ai new mcp
   alexa-ai configure-account-linking --addon-id <id> --stage development --client-id fieldnote-alexa
   alexa-ai deploy
   ```

   `configure-account-linking` prints the redirect URIs Amazon will use and takes the client secret. If you set
   `ALEXA_OAUTH_REDIRECT_URIS` to that list, only those are accepted; left empty, any
   `https://{alexa,pitangui,layla}.amazon.com/api/skill/link/<vendor>` is.

4. In the Alexa app, enable the skill and link your account. You are sent to `/oauth/authorize`, sign in with your Fieldnote
   password if you are not already, and approve the Household consent page.

`alexa-ai deploy` is also what refreshes Alexa's copy of the tool list. Run it again after any change to the tools.

### The protocol, as Amazon requires it

OAuth 2.1 authorization code with PKCE (`S256`, the only method advertised), and the `resource` parameter on both the
authorization and token requests, which must be exactly `<PUBLIC_BASE_URL>/mcp`. There is no dynamic client registration, so the
client is the one in `.env`. Discovery is published at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`. Access tokens last an hour and refresh tokens 90 days; a refresh rotates both, and the old
pair stops working the moment the new one exists. Codes are one-use and are spent by the first attempt, right or wrong. Only
SHA-256 hashes of codes and tokens are stored, so a copy of the database cannot be replayed against `/mcp`. `/mcp` answers a bad
token with a plain 401 and no `WWW-Authenticate` header, since Alexa+ does not support it, and it accepts the Bearer header only.

### What is public

The sign-in gate in [`server/routes/auth.ts`](../server/routes/auth.ts) exempts exactly these paths, through `isAlexaPublicPath()`:
`/mcp`, `/oauth/token`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. **`/oauth/authorize` is deliberately not exempt**: approving a link takes your own
session. Each public path is its own gate: `/mcp` needs a live Household token (failures are counted per caller, 30 per ten minutes,
and requests capped at 600), and `/oauth/token` needs the client's credentials and is limited to 60 requests per ten minutes. A
Household token opens nothing else; Bearer is not accepted by the rest of the API.

### Revoking

**Settings → Connections → Alexa → Unlink Alexa** revokes every token at once (`DELETE /api/integrations/alexa/link`). Alexa loses
access on its next call. You can also disable the skill in the Alexa app; that does not revoke Fieldnote's tokens, so unlink there
too. Removing `ALEXA_OAUTH_CLIENT_ID` stops new links and refreshes.

## Fieldnote → Alexa

### What it can do

Five tools, owner's own line only (the browser chat and your own text thread):

| Tool | Does |
|---|---|
| `list_home_devices` | Echo devices, smart-home devices (with whether Fieldnote will operate each) and rooms |
| `home_device_status` | One device's state |
| `control_home_device` | On or off for a device or every light in a room (`target_kind` `device` or `group`), or one device's brightness |
| `run_alexa_routine` | Starts a routine by name |
| `speak_on_echo` | Announces a short message, on every Echo or one by name |

They are in `OWNER_ONLY_TOOLS`, so a group turn is refused (`… is not available in a group chat`), and so is an Echo
(`… is not available by voice`). Fieldnote runs the `alexa-mcp` child itself, over stdio, rather than adding it to Agent Studio as an
MCP tool, for the same reason the web tools work that way: a tool attached to the agent runs outside the executor, with none of
these checks. It exposes five tools of its own, not the server's twenty-five.

### The safety policy

Operating a home is not like reading a todo list, so the executor is stricter:

- **Refused after outside text.** A turn that has read a web page, a search result or text in a picture cannot touch a device
  (`This turn read text someone else wrote …`, 409), and neither can a turn the app composed (a digest, a brief). A page cannot talk
  the assistant into turning a light off.
- **Locks, doors, garages, cameras and alarms are never operated.** The check is on the name (`ALEXA_BLOCKED_DEVICES`, a
  case-insensitive pattern; the default is `\b(?:un)?lock|padlock|deadbolt|garage|door|alarm|security|camera`) **and** on Alexa's own
  device type, so a lock the owner called "Hallway" is still refused. A room is refused when any member is blocked. A routine whose name
  matches is not run. An invalid pattern blocks every device rather than none. The reply is `Alexa refused: …` (403).
- **Names are resolved by Fieldnote, not by Alexa.** The model passes a name; Fieldnote lists the devices, picks one (exact, then
  prefix, then contains) and asks if it is ambiguous, and the device it checked is the device it operates.
- **No free-form commands.** `alexa_command`, the server's "say this to Alexa" tool, is never called: a spoken command can buy things
  and unlock doors. `speak_on_echo` refuses text that contains a wake word (`alexa`, `echo`, `computer`, `amazon`, `ziggy`), since an
  Echo saying it makes the next one act on what follows, and refuses anything over 300 characters.
- **A daily cap.** `ALEXA_DAILY_LIMIT` calls per local day (default 100; `0` turns the tools off, 503). Past it the tools answer 429.
  A call refused by policy, or that never reached Alexa, is given back; one that timed out keeps its place, since the device may have acted.
- **Unconfigured means unavailable**: `Alexa control is not configured` (503), without spending any of the allowance.

### Setup

`alexa-mcp` is an optional dependency (`"alexa-mcp": "0.4.4"`, pinned exactly), so `npm install` works without it, and the tools say
they are not configured until it is present. If you installed with `--omit=optional`, run `npm install alexa-mcp@0.4.4`.

1. Sign in to Amazon once: `npx alexa-mcp auth`. It leaves a login in `~/.alexa-mcp/config.json`; alternatively put the refresh
   token in `ALEXA_REFRESH_TOKEN` (and your site in `ALEXA_DOMAIN` if it is not `amazon.com`).
2. Restart the server. **Settings → Connections → Alexa** shows `Connected · N devices` when Amazon accepts it.
3. Run **Sync Agent config** under Settings → Under the hood. The five tools and the prompt's Home section reach Agent Studio only
   through that sync; until you run it the deployed agent does not know the tools exist.

### Risks, plainly

- **It uses Amazon's private API.** The community server signs in the way the Alexa app does. Amazon can change that without notice,
  and using it may not be within Amazon's terms for your account. Fieldnote's code is the supported part; the connection is not.
- **A stored credential can act on your home.** The refresh token is as sensitive as the Alexa app signed in on your phone. Keep
  `.env` out of version control (it is gitignored) and out of backups you share. If it leaks, change your Amazon password.
- **The dependency has a footprint.** `alexa-mcp` brings its own dependencies, including a patched `alexa-cookie2`, and is the reason
  `npm audit` may report findings that are not in Fieldnote's own code. It talks only to Amazon's hosts, plus `api.ipify.org` during
  its sign-in. The policy above is Fieldnote's, not the server's: anything else run with the same credentials is not covered by it.
- **Most of this is best effort.** A failure is reported as an `Alexa …` error (502) and is never retried by Fieldnote for you.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

[`tests/alexa.test.ts`](../tests/alexa.test.ts) covers the gate (no token, a Basic credential, an expired or revoked token, no
`WWW-Authenticate`), OAuth (PKCE mismatch, wrong resource, wrong redirect, a reused code, refresh rotation), the Household scope
(another area's todo cannot be read or changed, the voice allow-list in the executor, under 500 ms), the voice thread (no check-in,
reminders to the owner), and the device tools against a fake `alexa-mcp` client (blocked devices, the daily cap, wake words, refusal
in a group, from an Echo and after a web read). It never contacts Amazon.
