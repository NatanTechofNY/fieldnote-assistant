import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { AlgoliaSync, type AlgoliaOptions } from "./algolia.ts";
import { syncAgentStudioTools } from "./agent-studio.ts";
import { runChannelAgent } from "./agent-runner.ts";
import { getTwilioErrorMessage } from "./twilio-service.ts";
import { openDatabase } from "./db.ts";
import { failure } from "./http.ts";
import type { Db } from "./types.ts";
import type {
  AgentDrafter,
  AgentStudioService,
  RouteContext,
  SearchService,
} from "./routes/context.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerConversationRoutes } from "./routes/conversations.ts";
import { registerDigestBriefRoutes } from "./routes/digest-briefs.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerIntegrationRoutes } from "./routes/integrations.ts";
import { registerMemoryRoutes } from "./routes/memories.ts";
import { registerOverviewRoutes } from "./routes/overview.ts";
import { registerReflectionRoutes } from "./routes/reflections.ts";
import { registerReminderRoutes } from "./routes/reminders.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerTaxonomyRoutes } from "./routes/taxonomy.ts";
import { registerTodoRoutes } from "./routes/todos.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";

export type { SearchService, AgentStudioService } from "./routes/context.ts";

export interface AppOptions {
  db?: Db;
  databasePath?: string;
  search?: SearchService;
  agentStudio?: AgentStudioService;
  algolia?: AlgoliaOptions;
  corsOrigin?: string;
  serveStatic?: boolean;
  draftWithAgent?: AgentDrafter;
}

/**
 * Registration order is load-bearing: `registerAuthRoutes` installs the session
 * gate as middleware, so every module after it is protected and every module
 * before it is public.
 */
const registerRoutes = [
  registerAuthRoutes,
  registerHealthRoutes,
  registerIntegrationRoutes,
  registerWebhookRoutes,
  registerOverviewRoutes,
  registerTaxonomyRoutes,
  registerTodoRoutes,
  registerMemoryRoutes,
  registerReflectionRoutes,
  registerReminderRoutes,
  registerDigestBriefRoutes,
  registerConversationRoutes,
  registerSearchRoutes,
  registerAgentRoutes,
  registerAdminRoutes,
];

export function createApp(options: AppOptions = {}): { app: express.Express; db: Db; search: SearchService } {
  const db = options.db ?? openDatabase(options.databasePath);
  const search = options.search ?? new AlgoliaSync(db, options.algolia);
  const agentStudio = options.agentStudio ?? { syncTools: syncAgentStudioTools };
  const draftWithAgent: AgentDrafter = options.draftWithAgent ?? (async (
    prompt,
    address,
    draft = {},
  ) => (await runChannelAgent(db, search, draft.channel ?? "web", address, prompt, undefined, {
    userMessageMetadata: draft.context,
    internal: true,
  })).text);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(cors({ origin: options.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:4173" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(express.json({ limit: "1mb" }));

  const context: RouteContext = { app, db, search, agentStudio, draftWithAgent };
  for (const register of registerRoutes) register(context);

  app.use("/api", (_req, res) => failure(res, 404, "Route not found"));

  const shouldServeStatic = options.serveStatic ?? process.env.NODE_ENV === "production";
  const dist = resolve("dist");
  if (shouldServeStatic && existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*splat}", (_req, res) => res.sendFile(resolve(dist, "index.html")));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (error instanceof ZodError) return failure(res, 400, error.issues[0]?.message || "Invalid request");
    if (
      typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT")
    ) {
      return failure(res, 409, "Constraint violation");
    }
    const twilioError = getTwilioErrorMessage(error);
    if (twilioError) {
      console.error("Twilio request failed:", error);
      return failure(res, 400, twilioError);
    }
    console.error(error);
    return failure(res, 500, "Internal server error");
  });

  return { app, db, search };
}
