# syntax=docker/dockerfile:1
# The VITE_* build arguments below are search-scoped Algolia values that Vite
# inlines into the browser bundle by design, so they are public by definition
# and the secrets-in-build-args check does not apply to them.
# check=skip=SecretsUsedInArgOrEnv

# Fieldnote runs the UI, API, webhooks, and reminder worker in one process,
# so this image is the entire deployment: one container, one persistent volume.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles from source when no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines these into the browser bundle at build time, so they must be
# present now rather than at runtime. Only search-scoped values belong here.
ARG VITE_ALGOLIA_APPLICATION_ID=""
ARG VITE_ALGOLIA_SEARCH_API_KEY=""
ARG VITE_ALGOLIA_AGENT_ID=""
ARG VITE_ALGOLIA_TODO_INDEX="devcon_assistant_todos"
ENV VITE_ALGOLIA_APPLICATION_ID=$VITE_ALGOLIA_APPLICATION_ID \
    VITE_ALGOLIA_SEARCH_API_KEY=$VITE_ALGOLIA_SEARCH_API_KEY \
    VITE_ALGOLIA_AGENT_ID=$VITE_ALGOLIA_AGENT_ID \
    VITE_ALGOLIA_TODO_INDEX=$VITE_ALGOLIA_TODO_INDEX

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4174 \
    DATABASE_PATH=/data/assistant.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# Index settings, tool schemas, and the system prompt are read from disk at
# runtime by --setup-algolia and the Agent Studio tool sync.
COPY --from=build /app/agent-studio ./agent-studio
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json

# SQLite owns reminders and delivery state, so this must be a real volume.
VOLUME ["/data"]
EXPOSE 4174

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Invoked directly rather than through `npm start`, which nested the server four
# processes deep behind npm and sh. SIGTERM never reached the shutdown handler
# there, so the container exited 1 and closed SQLite by dying rather than by
# draining requests and checkpointing the WAL. NODE_ENV is already set above.
CMD ["node", "--import", "tsx", "server/index.ts"]
