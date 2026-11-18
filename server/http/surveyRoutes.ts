/**
 * @module http/surveyRoutes
 * Survey API (every route requires a signed-in user).
 *
 * GET  /api/surveys                                     surveys visible to the caller
 * POST /api/surveys                (admin)              { title, initialRecipient, questions[], lang }
 * POST /api/surveys/categorize     (admin)              { questions[] } -> automatic categories preview
 * GET  /api/surveys/:id                                 survey as seen by the caller
 * POST /api/surveys/:id/questions/:questionId/answer    { answer }
 * POST /api/surveys/:id/delegate                        { questionIds[] | category, newOwnerEmail, lang }
 *
 * Demo mode (ALLOW_DEMO_SURVEY_IDENTITY=true): a signed-in ADMIN may send the header
 * `X-Act-As: <email>` to act as that person (to present delegation with a single account).
 * The header is ignored for everyone else.
 */
import type { Context, Router } from "@oak/oak";
import { AppError } from "../errors.ts";
import { normalizeEmail } from "../services/csvService.ts";
import {
  answerQuestion,
  categorizeQuestion,
  createSurvey,
  delegateQuestions,
  getSurveyForViewer,
  listSurveysForViewer,
  type SurveyViewer,
  validateQuestions,
} from "../services/surveyService.ts";
import { type AppDeps, emailLanguage, readJsonBody, requireAdmin, requireUser } from "./helpers.ts";

/** Resolves who is acting: the session user, or the impersonated person in demo mode. */
async function resolveViewer(ctx: Context, deps: AppDeps): Promise<SurveyViewer> {
  const user = await requireUser(ctx, deps);
  const actAs = ctx.request.headers.get("x-act-as");
  if (actAs && deps.config.demoSurveyIdentity && user.isAdmin) {
    const email = normalizeEmail(actAs);
    if (!email) throw new AppError(400, "INVALID_EMAIL", "X-Act-As must be a valid email address.");
    if (email !== user.email) return { email, isAdmin: false };
  }
  return { email: user.email, isAdmin: user.isAdmin };
}

export function registerSurveyRoutes(router: Router, deps: AppDeps): void {
  router.get("/api/surveys", async (ctx) => {
    const viewer = await resolveViewer(ctx, deps);
    ctx.response.body = { surveys: listSurveysForViewer(deps, viewer) };
  });

  router.post("/api/surveys/categorize", async (ctx) => {
    await requireAdmin(ctx, deps);
    const body = await readJsonBody(ctx);
    const questions = validateQuestions(body.questions);
    ctx.response.body = { questions: questions.map((text) => ({ text, category: categorizeQuestion(text) })) };
  });

  router.post("/api/surveys", async (ctx) => {
    const admin = await requireAdmin(ctx, deps);
    const body = await readJsonBody(ctx);
    const result = await createSurvey(deps, body, admin.email, emailLanguage(deps, body.lang));
    ctx.response.status = 201;
    ctx.response.body = result;
  });

  router.get("/api/surveys/:id", async (ctx) => {
    const viewer = await resolveViewer(ctx, deps);
    ctx.response.body = getSurveyForViewer(deps, ctx.params.id, viewer);
  });

  router.post("/api/surveys/:id/questions/:questionId/answer", async (ctx) => {
    const viewer = await resolveViewer(ctx, deps);
    const body = await readJsonBody(ctx, 64 * 1024);
    ctx.response.body = { survey: answerQuestion(deps, ctx.params.id, ctx.params.questionId, viewer, body.answer) };
  });

  router.post("/api/surveys/:id/delegate", async (ctx) => {
    const viewer = await resolveViewer(ctx, deps);
    const body = await readJsonBody(ctx);
    ctx.response.body = await delegateQuestions(deps, ctx.params.id, viewer, body, emailLanguage(deps, body.lang));
  });
}
