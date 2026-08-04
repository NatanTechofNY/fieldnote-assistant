# Contributing to Fieldnote

Thanks for taking an interest. Fieldnote is a personal demo project rather than a supported product, so contributions are welcome but reviews may be slow.

## Reporting an issue

Open a [bug report](https://github.com/NatanTechofNY/fieldnote-assistant/issues/new?template=bug_report.yml) for defects. Questions and feature ideas belong in [Discussions](https://github.com/NatanTechofNY/fieldnote-assistant/discussions).

Never paste real credentials, phone numbers, Twilio SIDs, or the contents of your `assistant.db` into an issue. Redact them first.

Found a security vulnerability? Do not open an issue. Follow [SECURITY.md](SECURITY.md) instead.

## Requirements

- Node.js 22 (the version in `.nvmrc`)
- npm

Algolia credentials are optional. The app runs in local mode without them, which is enough for most changes.

## Launch the dev environment

```bash
cp .env.example .env
npm install
npm run dev
```

The UI runs on port `4173` and the API on `4174`. `npm run seed` adds sample data and `npm run reset` restores a known dataset.

## Code contribution

1. Fork the repository and branch from `main`.
2. Make your change.
3. Run the checks below.
4. Open a pull request describing what changed and why.

```bash
npm run lint
npm run typecheck
npm test
```

CI runs these plus a production build, and separately builds the Docker image and asserts that the container boots, requires authentication, and serves the app.

### Things to know before changing the server

SQLite is the source of truth and Algolia holds derived projections, so a change that writes data must also enqueue the corresponding index job. Reindexing is always safe to repeat.

The reminder worker assumes exactly one writer. Anything that introduces a second concurrent writer to the database is a correctness bug, not just a performance concern.

Authentication is registered first, in `server/routes/auth.ts`, so every route added afterwards is gated by default. Only `/api/health` and `/api/webhooks/*` are exempt. If you add a route that should be public, add it to that allowlist deliberately and think about what it exposes to an unauthenticated caller.

Agent tools do not go through the REST API. They run in `server/tool-executor.ts`, which the browser reaches via `POST /api/agent/tools/:name` and the SMS worker calls in-process. A behavior change usually has to be made in both the tool executor and the equivalent REST route, and `npm test` checks that the published tool schemas still match `server/schemas.ts`.

## Commit conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org): `type(scope): description`, using `fix`, `feat`, `refactor`, `docs`, `test`, or `chore`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers this project.
