# Security policy

## Reporting a vulnerability in Fieldnote

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/NatanTechofNY/fieldnote-assistant/security/advisories/new) and open a draft advisory. This is a personal project maintained in spare time, so expect an initial response within a couple of weeks rather than a couple of hours.

Fieldnote is a demo and carries **no SLA and no guaranteed patch timeline**. If you depend on it, review the code yourself.

## Vulnerabilities in Algolia, Twilio, Sendblue, or Granola

This project is not affiliated with those companies. Report issues in their services to them directly, not here:

- Algolia runs a public bug bounty at [hackerone.com/algolia](https://hackerone.com/algolia), with `security@algolia.com` as the general contact.
- Twilio, Sendblue, and Granola each publish their own disclosure processes.

## Security model, and what it does not cover

Understand these properties before exposing an instance to the internet.

`APP_ADMIN_PASSWORD` is the single credential protecting the app. Browsers sign in at `/login` and receive an `HttpOnly`, `SameSite=Lax` session cookie; scripts and integrations can keep using HTTP Basic Auth with the username `admin`. Passwords are compared using scrypt, and repeated failures from one host are locked out for 15 minutes. Only a SHA-256 hash of each session token is stored, so a leaked database cannot be replayed as a live session.

The server **refuses to start in production when `APP_ADMIN_PASSWORD` is unset**, because the alternative is silently serving everything to anyone. Setting `APP_ALLOW_NO_AUTH=true` overrides this deliberately; only do that on a trusted, isolated network.

Two paths bypass authentication because neither can present credentials: `/api/health`, which returns liveness only to unauthenticated callers, and `/api/webhooks/*`, which is protected instead by the provider's own proof. Twilio signs its requests and the signature is validated against the exact public URL. Sendblue signs nothing, so connecting it mints a random secret that it echoes back on every webhook; a request without that secret is refused.

The session cookie is marked `Secure` only when the request arrives over HTTPS, since many installs are a LAN machine on plain HTTP where a `Secure` cookie would be silently dropped. Over plain HTTP the cookie and password are visible to anyone who can observe the network, so put TLS in front of any deployment that leaves your own network.

`SETTINGS_ENCRYPTION_KEY` encrypts stored Twilio, Sendblue, and Granola credentials with AES-256-GCM. Losing it makes those credentials unreadable; leaking it makes them recoverable by anyone holding a copy of the database. Back it up separately from the database and generate it with `openssl rand -base64 32` rather than choosing something memorable.

The `VITE_*` variables are inlined into the browser bundle at build time and are readable by anyone loading the page. Only search-scoped Algolia keys belong there. An admin API key placed in a `VITE_*` variable is public the moment you deploy.

`TWILIO_SKIP_SIGNATURE_VALIDATION` disables webhook authenticity checks. It is ignored when `NODE_ENV=production` and exists only for tests and local debugging.

SQLite contents are not encrypted at rest beyond the integration secrets described above. Personal notes, memories, and message history are stored in plaintext, so treat the database file and its backups as sensitive.
