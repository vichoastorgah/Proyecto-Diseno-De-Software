/**
 * @module services/surveyService
 * Mass surveys: automatic categorization, a single initial recipient, delegation of one or
 * more questions (or a whole category), answers and consolidated progress.
 *
 * Responsibility rule: `survey_questions.current_owner` is a single column, so a question
 * always has exactly one responsible. Delegating rewrites it (guarded by
 * `WHERE current_owner = <caller> AND status = 'pending'`) and appends to the audit trail;
 * the previous owner loses the responsibility in the same transaction.
 *
 * Visibility:
 * - admin and initial recipient: every question and answer (consolidated view).
 * - participant (current/past owner of a question): only the questions they own or handled,
 *   plus the consolidated progress figures.
 * - anyone else: the survey does not exist (404).
 */
import { AppError, notFound, validationError } from "../errors.ts";
import type { Db } from "../db/database.ts";
import type { ServiceContext } from "../context.ts";
import { normalizeEmail } from "./csvService.ts";
import { type EmailLanguage, renderSurveyNotice } from "./emailService.ts";

export const FALLBACK_CATEGORY = "general";
const MAX_SURVEY_QUESTIONS = 200;
const MAX_QUESTION_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 200;
const MAX_ANSWER_LENGTH = 5_000;

// ---------- Contracts ----------

/** Who is looking at a survey. */
export interface SurveyViewer {
  email: string;
  isAdmin: boolean;
}

export type ViewerRole = "admin" | "recipient" | "participant";

export interface DelegationEntry {
  from: string;
  to: string;
  delegatedAt: string;
}

export interface SurveyQuestionView {
  id: string;
  code: string;
  category: string;
  text: string;
  originalAssignee: string;
  currentOwner: string;
  status: "pending" | "answered";
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  delegationHistory: DelegationEntry[];
}

export interface CategoryProgress {
  total: number;
  answered: number;
  percentage: number;
}

export interface SurveyProgress {
  totalQuestions: number;
  answeredQuestions: number;
  pendingQuestions: number;
  completionPercentage: number;
  byCategory: Record<string, CategoryProgress>;
  /** Pending questions per current owner (who still has work to do). */
  pendingByOwner: Record<string, number>;
}

export interface SurveyView {
  id: string;
  title: string;
  initialRecipient: string;
  createdAt: string;
  viewerEmail: string;
  viewerRole: ViewerRole;
  progress: SurveyProgress;
  questions: SurveyQuestionView[];
  /** Questions that exist but are not visible to this viewer. */
  hiddenQuestionCount: number;
}

export interface SurveyListItem {
  id: string;
  title: string;
  initialRecipient: string;
  createdAt: string;
  viewerRole: ViewerRole;
  progress: { totalQuestions: number; answeredQuestions: number; completionPercentage: number };
  /** Pending questions currently owned by the viewer. */
  myPendingQuestions: number;
}

// ---------- Automatic categorization ----------

/**
 * Keyword table in priority order (earlier categories win ties). Keywords match as word
 * prefixes after lower-casing and removing accents ("budget" also matches "budgets").
 * Spanish keywords are plain data so Spanish questions are classified too.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["finance", [
    "budget", "margin", "revenue", "profit", "cost", "expense", "fiscal", "cash flow", "tax",
    "invest", "financ", "debt", "loan", "earnings", "income", "price", "pricing", "audit",
    "presupuesto", "margen", "ingreso", "ganancia", "costo", "gasto", "impuesto", "inversion",
    "deuda", "flujo de caja", "utilidad", "finanz", "precio", "auditoria", "credito",
  ]],
  ["operations", [
    "incident", "production", "process", "logistic", "supply chain", "inventory", "delivery",
    "uptime", "downtime", "capacity", "maintenance", "quality", "supplier", "operation",
    "warehouse", "throughput", "efficiency",
    "incidente", "produccion", "proceso", "logistica", "cadena de suministro", "inventario",
    "entrega", "capacidad", "mantenimiento", "calidad", "proveedor", "operacion", "bodega",
    "eficiencia", "despacho",
  ]],
  ["environment", [
    "environment", "emission", "carbon", "waste", "energy", "sustainab", "recycl", "climate",
    "water", "pollution", "renewable", "biodiversity", "footprint",
    "medio ambiente", "medioambiente", "ambiental", "emision", "carbono", "residuo", "energia",
    "sostenib", "sustentab", "reciclaje", "clima", "contaminacion", "huella", "agua",
  ]],
  ["marketing", [
    "marketing", "campaign", "brand", "customer", "advertis", "social media", "market share",
    "promotion", "audience", "engagement", "conversion", "newsletter",
    "campana", "marca", "cliente", "publicidad", "redes sociales", "promocion", "audiencia",
    "posicionamiento", "mercado",
  ]],
  ["hr", [
    "employee", "hiring", "recruit", "turnover", "training", "payroll", "headcount", "benefits",
    "talent", "onboarding", "personnel", "staff",
    "empleado", "contratacion", "reclutamiento", "rotacion", "capacitacion", "nomina",
    "dotacion", "talento", "colaborador", "remuneracion",
  ]],
  ["legal", [
    "legal", "law", "contract", "litigation", "regulat", "lawsuit", "intellectual property",
    "patent", "compliance",
    "contrato", "litigio", "regulacion", "normativa", "propiedad intelectual", "patente",
    "cumplimiento",
  ]],
  ["it", [
    "software", "server", "database", "cyber", "network", "cloud", "infrastructure", "hardware",
    "data center", "security breach",
    "servidor", "base de datos", "ciberseguridad", "infraestructura", "nube", "informatic",
    "tecnologia",
  ]],
];

/** Category keys known by the classifier (plus the fallback). */
export const CATEGORIES = [...CATEGORY_KEYWORDS.map(([category]) => category), FALLBACK_CATEGORY];

function normalizeForMatching(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CATEGORY_MATCHERS = CATEGORY_KEYWORDS.map(([category, keywords]) => ({
  category,
  patterns: keywords.map((keyword) => new RegExp(`\\b${escapeRegExp(normalizeForMatching(keyword))}`)),
}));

/**
 * Classifies a question by keyword matching: most hits wins, ties go to the earlier
 * category, no hit yields {@link FALLBACK_CATEGORY}. O(k * L).
 */
export function categorizeQuestion(text: string): string {
  const normalized = normalizeForMatching(text);
  let best = FALLBACK_CATEGORY;
  let bestScore = 0;
  for (const { category, patterns } of CATEGORY_MATCHERS) {
    const score = patterns.reduce((hits, pattern) => hits + (pattern.test(normalized) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return best;
}

// ---------- Validation ----------

function requireEmail(value: unknown, field: string): string {
  const email = typeof value === "string" ? normalizeEmail(value) : null;
  if (!email) throw validationError(`${field} must be a valid email address.`, [{ code: "INVALID_EMAIL", message: field, field }]);
  return email;
}

/** Validates question texts (1-200 questions, 1-1000 characters each). */
export function validateQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw validationError("At least one question is required.", [{ code: "QUESTIONS_REQUIRED", message: "questions" }]);
  }
  if (questions.length > MAX_SURVEY_QUESTIONS) {
    throw validationError(`A survey cannot exceed ${MAX_SURVEY_QUESTIONS} questions.`, [
      { code: "QUESTIONS_TOO_MANY", message: "questions", value: String(MAX_SURVEY_QUESTIONS) },
    ]);
  }
  const texts = questions.map((question) => (typeof question === "string" ? question.trim().replace(/\s+/g, " ") : ""));
  const invalid = texts.findIndex((text) => text === "" || text.length > MAX_QUESTION_LENGTH);
  if (invalid !== -1) {
    throw validationError(`Question ${invalid + 1} must be 1-${MAX_QUESTION_LENGTH} characters long.`, [
      { code: "QUESTION_INVALID", message: `Question ${invalid + 1}`, row: invalid + 1 },
    ]);
  }
  return texts;
}

// ---------- Queries ----------

interface QuestionRow {
  id: string;
  code: string;
  category: string;
  text: string;
  original_assignee: string;
  current_owner: string;
  status: "pending" | "answered";
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

interface SurveyRow {
  id: string;
  title: string;
  initial_recipient: string;
  created_at: string;
}

const percentage = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/** Recomputes progress from the questions (derived data is never stored, so it cannot drift). */
export function computeProgress(questions: readonly Pick<QuestionRow, "category" | "status" | "current_owner">[]): SurveyProgress {
  const byCategory: Record<string, CategoryProgress> = {};
  const pendingByOwner: Record<string, number> = {};
  let answered = 0;
  for (const question of questions) {
    const entry = byCategory[question.category] ?? { total: 0, answered: 0, percentage: 0 };
    entry.total += 1;
    if (question.status === "answered") {
      entry.answered += 1;
      answered += 1;
    } else {
      pendingByOwner[question.current_owner] = (pendingByOwner[question.current_owner] ?? 0) + 1;
    }
    byCategory[question.category] = entry;
  }
  for (const entry of Object.values(byCategory)) entry.percentage = percentage(entry.answered, entry.total);
  return {
    totalQuestions: questions.length,
    answeredQuestions: answered,
    pendingQuestions: questions.length - answered,
    completionPercentage: percentage(answered, questions.length),
    byCategory,
    pendingByOwner,
  };
}

/** True when the email is the recipient, an owner or a delegate of any survey. */
export async function isSurveyParticipant(ctx: ServiceContext, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const row = await ctx.db.get(
    `SELECT 1 FROM surveys WHERE initial_recipient = $1
     UNION ALL SELECT 1 FROM survey_questions WHERE current_owner = $1 OR original_assignee = $1
     UNION ALL SELECT 1 FROM survey_delegations WHERE to_email = $1 OR from_email = $1
     LIMIT 1`,
    normalized,
  );
  return row !== undefined;
}

/**
 * Participants only get the global figures: the breakdown by category and by person
 * describes questions they are not allowed to see.
 */
function withoutBreakdown(progress: SurveyProgress): SurveyProgress {
  return { ...progress, byCategory: {}, pendingByOwner: {} };
}

/** Emails that handled a question (current owner, delegations, answer). */
function handlersOf(question: QuestionRow, history: DelegationEntry[]): Set<string> {
  const people = new Set([question.current_owner, question.original_assignee]);
  for (const entry of history) {
    people.add(entry.from);
    people.add(entry.to);
  }
  if (question.answered_by) people.add(question.answered_by);
  return people;
}

/**
 * Builds the survey as seen by `viewer`.
 * @throws {AppError} 404 SURVEY_NOT_FOUND when it does not exist or the viewer has no access.
 */
export async function getSurveyForViewer(db: Db, surveyId: string, viewer: SurveyViewer): Promise<SurveyView> {
  const survey = await db.get<SurveyRow>("SELECT id, title, initial_recipient, created_at FROM surveys WHERE id = $1", surveyId);
  if (!survey) throw notFound("SURVEY_NOT_FOUND", "Survey not found.");

  const questions = await db.all<QuestionRow>(
    `SELECT id, code, category, text, original_assignee, current_owner, status, answer, answered_by, answered_at
     FROM survey_questions WHERE survey_id = $1 ORDER BY position`,
    surveyId,
  );
  const historyRows = await db.all<{ question_id: string; from_email: string; to_email: string; delegated_at: string }>(
    `SELECT d.question_id, d.from_email, d.to_email, d.delegated_at FROM survey_delegations d
     JOIN survey_questions q ON q.id = d.question_id WHERE q.survey_id = $1 ORDER BY d.id`,
    surveyId,
  );
  const history = new Map<string, DelegationEntry[]>();
  for (const row of historyRows) {
    const list = history.get(row.question_id) ?? [];
    list.push({ from: row.from_email, to: row.to_email, delegatedAt: row.delegated_at });
    history.set(row.question_id, list);
  }

  const email = viewer.email.toLowerCase();
  let role: ViewerRole;
  if (viewer.isAdmin) role = "admin";
  else if (survey.initial_recipient === email) role = "recipient";
  else role = "participant";

  const views = questions.map((question) => ({ question, history: history.get(question.id) ?? [] }));
  const visible = role === "participant"
    ? views.filter(({ question, history }) => handlersOf(question, history).has(email))
    : views;
  if (role === "participant" && visible.length === 0) throw notFound("SURVEY_NOT_FOUND", "Survey not found.");

  return {
    id: survey.id,
    title: survey.title,
    initialRecipient: survey.initial_recipient,
    createdAt: survey.created_at,
    viewerEmail: email,
    viewerRole: role,
    progress: role === "participant" ? withoutBreakdown(computeProgress(questions)) : computeProgress(questions),
    questions: visible.map(({ question, history }) => ({
      id: question.id,
      code: question.code,
      category: question.category,
      text: question.text,
      originalAssignee: question.original_assignee,
      currentOwner: question.current_owner,
      status: question.status,
      answer: question.answer,
      answeredBy: question.answered_by,
      answeredAt: question.answered_at,
      delegationHistory: history,
    })),
    hiddenQuestionCount: questions.length - visible.length,
  };
}

/** Surveys visible to the viewer (all of them for admins), newest first. */
export async function listSurveysForViewer(ctx: ServiceContext, viewer: SurveyViewer): Promise<SurveyListItem[]> {
  const email = viewer.email.toLowerCase();
  const rows = await ctx.db.all<SurveyRow & { total: number; answered: number; mine: number }>(
    `SELECT s.id, s.title, s.initial_recipient, s.created_at,
            COUNT(q.id) AS total,
            COUNT(q.id) FILTER (WHERE q.status = 'answered') AS answered,
            COUNT(q.id) FILTER (WHERE q.status = 'pending' AND q.current_owner = $1) AS mine
     FROM surveys s LEFT JOIN survey_questions q ON q.survey_id = s.id
     WHERE $2
        OR s.initial_recipient = $1
        OR EXISTS (SELECT 1 FROM survey_questions x WHERE x.survey_id = s.id
                   AND (x.current_owner = $1 OR x.original_assignee = $1 OR x.answered_by = $1))
        OR EXISTS (SELECT 1 FROM survey_delegations d JOIN survey_questions y ON y.id = d.question_id
                   WHERE y.survey_id = s.id AND (d.to_email = $1 OR d.from_email = $1))
     GROUP BY s.id
     ORDER BY s.created_at DESC`,
    email,
    viewer.isAdmin,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    initialRecipient: row.initial_recipient,
    createdAt: row.created_at,
    viewerRole: viewer.isAdmin ? "admin" : row.initial_recipient === email ? "recipient" : "participant",
    progress: {
      totalQuestions: Number(row.total),
      answeredQuestions: Number(row.answered),
      completionPercentage: percentage(Number(row.answered), Number(row.total)),
    },
    myPendingQuestions: Number(row.mine),
  }));
}

// ---------- Notifications ----------

/** Emails a survey notice; failures are logged and never undo the committed change. */
async function notify(
  ctx: ServiceContext,
  to: string,
  surveyId: string,
  surveyTitle: string,
  questionCount: number,
  kind: "initial" | "delegated",
  language: EmailLanguage,
  fromEmail?: string,
): Promise<boolean> {
  const message = renderSurveyNotice({
    language,
    surveyTitle,
    questionCount,
    link: `${ctx.config.appBaseUrl}/surveys/${encodeURIComponent(surveyId)}`,
    kind,
    fromEmail,
  });
  try {
    await ctx.mailer.send({ to, ...message, attachments: [] });
    return true;
  } catch (error) {
    console.error("Survey notification failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------- Commands ----------

export interface CreateSurveyInput {
  title?: unknown;
  initialRecipient?: unknown;
  questions?: unknown;
}

/**
 * Creates a survey addressed to a single person; every question starts owned by them and
 * is categorized automatically. The recipient is notified by email.
 */
export async function createSurvey(
  ctx: ServiceContext,
  input: CreateSurveyInput,
  actorEmail: string,
  language: EmailLanguage,
): Promise<{ survey: SurveyView; notified: boolean }> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "" || title.length > MAX_TITLE_LENGTH) {
    throw validationError(`Title is required (max. ${MAX_TITLE_LENGTH} characters).`, [
      { code: "SURVEY_TITLE_INVALID", message: "title", field: "title" },
    ]);
  }
  const recipient = requireEmail(input.initialRecipient, "initialRecipient");
  const texts = validateQuestions(input.questions);

  const surveyId = crypto.randomUUID();
  const now = new Date().toISOString();
  await ctx.db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO surveys (id, title, initial_recipient, created_by, created_at) VALUES ($1, $2, $3, $4, $5)",
      surveyId, title, recipient, actorEmail, now,
    );
    for (const [index, text] of texts.entries()) {
      await tx.run(
        `INSERT INTO survey_questions (id, survey_id, position, code, category, text, original_assignee, current_owner, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        crypto.randomUUID(), surveyId, index + 1, `q-${String(index + 1).padStart(3, "0")}`,
        categorizeQuestion(text), text, recipient, recipient,
      );
    }
  });

  const notified = await notify(ctx, recipient, surveyId, title, texts.length, "initial", language);
  return { survey: await getSurveyForViewer(ctx.db, surveyId, { email: actorEmail, isAdmin: true }), notified };
}

/**
 * Saves the answer of a question. Only its current owner can answer, once.
 * @throws {AppError} 400, 403 NOT_QUESTION_OWNER, 404, 409 QUESTION_ALREADY_ANSWERED.
 */
export async function answerQuestion(
  ctx: ServiceContext,
  surveyId: string,
  questionId: string,
  viewer: SurveyViewer,
  answerText: unknown,
): Promise<SurveyView> {
  const email = viewer.email.toLowerCase();
  const text = typeof answerText === "string" ? answerText.trim() : "";
  if (text === "") throw validationError("The answer cannot be empty.", [{ code: "ANSWER_EMPTY", message: "answer" }]);
  if (text.length > MAX_ANSWER_LENGTH) {
    throw validationError(`The answer cannot exceed ${MAX_ANSWER_LENGTH} characters.`, [
      { code: "ANSWER_TOO_LONG", message: "answer", value: String(MAX_ANSWER_LENGTH) },
    ]);
  }

  await ctx.db.transaction(async (tx) => {
    const question = await tx.get<{ current_owner: string; status: string }>(
      "SELECT current_owner, status FROM survey_questions WHERE id = $1 AND survey_id = $2 FOR UPDATE", questionId, surveyId,
    );
    if (!question) throw notFound("QUESTION_NOT_FOUND", "Question not found.");
    if (question.status === "answered") throw new AppError(409, "QUESTION_ALREADY_ANSWERED", "This question has already been answered.");
    if (question.current_owner !== email) {
      throw new AppError(403, "NOT_QUESTION_OWNER", "Only the person responsible for this question can answer it.");
    }
    const changed = await tx.run(
      `UPDATE survey_questions SET status = 'answered', answer = $1, answered_by = $2, answered_at = $3
       WHERE id = $4 AND current_owner = $2 AND status = 'pending'`,
      text, email, new Date().toISOString(), questionId,
    );
    if (changed !== 1) throw new AppError(409, "CONFLICT", "The question changed meanwhile. Reload and try again.");
  });
  return await getSurveyForViewer(ctx.db, surveyId, viewer);
}

export interface DelegateInput {
  questionIds?: unknown;
  category?: unknown;
  newOwnerEmail?: unknown;
}

/**
 * Hands one or more pending questions (or every pending question the caller owns in a
 * category) over to another person. All-or-nothing: if one question cannot be delegated,
 * nothing changes. The new owner is notified by email.
 * @throws {AppError} 400, 403 NOT_QUESTION_OWNER, 404, 409 QUESTION_ALREADY_ANSWERED / NOTHING_TO_DELEGATE.
 */
export async function delegateQuestions(
  ctx: ServiceContext,
  surveyId: string,
  viewer: SurveyViewer,
  input: DelegateInput,
  language: EmailLanguage,
): Promise<{ survey: SurveyView; transferredQuestionIds: string[]; notified: boolean }> {
  const actor = viewer.email.toLowerCase();
  const newOwner = requireEmail(input.newOwnerEmail, "newOwnerEmail");
  if (newOwner === actor) {
    throw new AppError(400, "DELEGATE_TO_SELF", "The new responsible must be a different person.");
  }

  const ids = Array.isArray(input.questionIds) ? input.questionIds.filter((id): id is string => typeof id === "string") : [];
  const category = typeof input.category === "string" ? input.category.trim().toLowerCase() : "";
  if ((ids.length > 0) === (category !== "")) {
    throw validationError("Provide either questionIds or category.", [{ code: "DELEGATION_TARGET_REQUIRED", message: "target" }]);
  }

  const survey = await ctx.db.get<SurveyRow>("SELECT id, title, initial_recipient, created_at FROM surveys WHERE id = $1", surveyId);
  if (!survey) throw notFound("SURVEY_NOT_FOUND", "Survey not found.");

  type Target = { id: string; current_owner: string; status: string };
  const transferred = await ctx.db.transaction(async (tx) => {
    let targets: Target[];
    if (ids.length > 0) {
      targets = [];
      for (const id of new Set(ids)) {
        const question = await tx.get<Target>(
          "SELECT id, current_owner, status FROM survey_questions WHERE id = $1 AND survey_id = $2 FOR UPDATE", id, surveyId,
        );
        if (!question) throw notFound("QUESTION_NOT_FOUND", "Question not found.");
        targets.push(question);
      }
      if (targets.some((question) => question.status === "answered")) {
        throw new AppError(409, "QUESTION_ALREADY_ANSWERED", "Answered questions cannot be delegated.");
      }
      if (targets.some((question) => question.current_owner !== actor)) {
        throw new AppError(403, "NOT_QUESTION_OWNER", "Only the person responsible for a question can delegate it.");
      }
    } else {
      const inCategory = await tx.all<Target>(
        "SELECT id, current_owner, status FROM survey_questions WHERE survey_id = $1 AND category = $2 ORDER BY position FOR UPDATE",
        surveyId, category,
      );
      if (inCategory.length === 0) throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
      targets = inCategory.filter((question) => question.status === "pending" && question.current_owner === actor);
      if (targets.length === 0) {
        throw new AppError(409, "NOTHING_TO_DELEGATE", "You have no pending questions in this category.");
      }
    }

    const now = new Date().toISOString();
    for (const question of targets) {
      const changed = await tx.run(
        "UPDATE survey_questions SET current_owner = $1 WHERE id = $2 AND current_owner = $3 AND status = 'pending'",
        newOwner, question.id, actor,
      );
      if (changed !== 1) throw new AppError(409, "CONFLICT", "The question changed meanwhile. Reload and try again.");
      await tx.run(
        "INSERT INTO survey_delegations (question_id, from_email, to_email, delegated_at) VALUES ($1, $2, $3, $4)",
        question.id, actor, newOwner, now,
      );
    }
    return targets.map((question) => question.id);
  });

  const notified = await notify(ctx, newOwner, surveyId, survey.title, transferred.length, "delegated", language, actor);
  return { survey: await getSurveyForViewer(ctx.db, surveyId, viewer), transferredQuestionIds: transferred, notified };
}
