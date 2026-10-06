import { Application, Router, Status } from "jsr:@oak/oak@^17";

/* ------------------------------------------------------------------ */
/* Contracts                                                          */
/* ------------------------------------------------------------------ */

type QuestionCategory = "finance" | "operations" | "marketing";
type QuestionStatus = "pending" | "answered";

interface DelegationRecord {
  from: string;
  to: string;
  delegatedAt: string; // ISO 8601
}

interface Question {
  id: string;
  category: QuestionCategory;
  text: string;
  originalAssignee: string;
  currentOwner: string; // Sole owner; previous owner loses ownership
  status: QuestionStatus;
  answer: string | null;
  answeredAt: string | null; // ISO 8601
  delegationHistory: DelegationRecord[];
}

interface CategoryProgress {
  total: number;
  answered: number;
}

interface SurveyProgress {
  totalQuestions: number;
  answeredQuestions: number;
  pendingQuestions: number;
  completionPercentage: number;
  byCategory: Record<QuestionCategory, CategoryProgress>;
}

interface Survey {
  id: string;
  title: string;
  initialRecipient: string;
  createdAt: string; // ISO 8601
  progress: SurveyProgress;
  questions: Question[];
}

interface ApiError {
  error: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const ALLOWED_ORIGINS: string[] = (
  Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:3000"
).split(",");
const DATA_FILE_URL = new URL("./data.json", import.meta.url);

/* ------------------------------------------------------------------ */
/* Data access                                                        */
/* ------------------------------------------------------------------ */

/** Reads and parses the survey state from data.json. */
async function readSurvey(): Promise<Survey> {
  const raw = await Deno.readTextFile(DATA_FILE_URL);
  return JSON.parse(raw) as Survey;
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

const router = new Router();

router.get("/api/survey", async (ctx) => {
  try {
    ctx.response.status = Status.OK;
    ctx.response.body = await readSurvey();
  } catch (err) {
    const body: ApiError = err instanceof Deno.errors.NotFound
      ? {
        error: "DATA_FILE_NOT_FOUND",
        message: "Survey data file was not found on the server.",
      }
      : err instanceof SyntaxError
      ? {
        error: "DATA_FILE_INVALID",
        message: "Survey data file contains invalid JSON.",
      }
      : {
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred while reading survey data.",
      };

    console.error(`[GET /api/survey] ${body.error}:`, err);
    ctx.response.status = err instanceof Deno.errors.NotFound
      ? Status.NotFound
      : Status.InternalServerError;
    ctx.response.body = body;
  }
});

/* ------------------------------------------------------------------ */
/* Application                                                        */
/* ------------------------------------------------------------------ */

const app = new Application();

// Global error handler
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("[Unhandled error]", err);
    const body: ApiError = {
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    };
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = body;
  }
});

// CORS middleware (allows the local React client)
app.use(async (ctx, next) => {
  const origin = ctx.request.headers.get("Origin");

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    ctx.response.headers.set("Access-Control-Allow-Origin", origin);
    ctx.response.headers.set("Vary", "Origin");
    ctx.response.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    ctx.response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = Status.NoContent;
    return;
  }

  await next();
});

app.use(router.routes());
app.use(router.allowedMethods());

// 404 fallback
app.use((ctx) => {
  const body: ApiError = {
    error: "NOT_FOUND",
    message: `Route ${ctx.request.url.pathname} not found.`,
  };
  ctx.response.status = Status.NotFound;
  ctx.response.body = body;
});

app.addEventListener("listen", ({ hostname, port }) => {
  console.log(`Server running on http://${hostname}:${port}`);
});

await app.listen({ port: PORT });