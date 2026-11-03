/**
 * @module services/surveyService
 * Massive survey engine: automatic categorization, answering, delegation and progress.
 * Every write to `data.json` goes through the shared `withWriteLock` queue.
 */
import { withWriteLock } from "../utils/fileLock.ts";

/** One entry of the delegation audit trail. */
export interface DelegationEntry {
  from: string;
  to: string;
  delegatedAt: string;
}

export type QuestionStatus = "pending" | "answered";

export interface SurveyQuestion {
  id: string;
  category: string;
  text: string;
  originalAssignee: string;
  currentOwner: string;
  status: QuestionStatus;
  answer: string | null;
  answeredAt: string | null;
  delegationHistory: DelegationEntry[];
}

export interface CategoryProgress {
  total: number;
  answered: number;
}

export interface SurveyProgress {
  totalQuestions: number;
  answeredQuestions: number;
  pendingQuestions: number;
  completionPercentage: number;
  byCategory: Record<string, CategoryProgress>;
}

export interface Survey {
  id: string;
  title: string;
  initialRecipient: string;
  createdAt: string;
  progress: SurveyProgress;
  questions: SurveyQuestion[];
}

/** Input contract of {@link delegateResponsibility}. Provide `questionId` OR `category`. */
export interface DelegateParams {
  questionId?: string;
  category?: string;
  currentOwnerEmail: string;
  newOwnerEmail: string;
}

/** Result of a delegation: the ids that changed hands and the updated survey. */
export interface DelegateResult {
  transferredQuestionIds: string[];
  survey: Survey;
}

/** Error carrying the HTTP status the HTTP layer should answer with. */
export class SurveyServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SurveyServiceError";
    this.status = status;
  }
}

// ---------- Constants ----------

const SURVEY_FILE = new URL("../data.json", import.meta.url);
const SURVEY_TEMP_FILE = new URL("../data.json.tmp", import.meta.url);
const MAX_ANSWER_LENGTH = 5_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Persistence ----------


/** Reads and validates the survey document from disk. */
export async function readSurvey(): Promise<Survey> {
  const raw = await Deno.readTextFile(SURVEY_FILE);
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as Survey).questions)
  ) {
    throw new Error("data.json is corrupted: missing questions array.");
  }
  return parsed as Survey;
}

/** Atomically writes the survey (temp file + rename) so a crash never leaves partial JSON. */
export async function writeSurvey(survey: Survey): Promise<void> {
  await Deno.writeTextFile(SURVEY_TEMP_FILE, JSON.stringify(survey, null, 2));
  await Deno.rename(SURVEY_TEMP_FILE, SURVEY_FILE);
}

// ---------- Helpers ----------

/** Normalizes an email for comparison and storage. */
function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Normalizes a category key for comparison. */
function normalizeCategory(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Throws 400 unless `email` looks like a valid email address. */
function assertValidEmail(email: string, label: string): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw new SurveyServiceError(400, `${label} must be a valid email address.`);
  }
}

/**
 * Recalculates the global and per-category progress from the question list.
 * Pure function: derived data is never trusted from disk, so it cannot drift.
 * Complexity: O(n) over the number of questions.
 */
export function recalculateProgress(questions: readonly SurveyQuestion[]): SurveyProgress {
  const byCategory: Record<string, CategoryProgress> = {};
  let answered = 0;

  for (const question of questions) {
    const key = normalizeCategory(question.category);
    const entry = byCategory[key] ?? { total: 0, answered: 0 };
    entry.total += 1;
    if (question.status === "answered") {
      entry.answered += 1;
      answered += 1;
    }
    byCategory[key] = entry;
  }

  const total = questions.length;
  const percentage = total === 0 ? 0 : Math.round((answered / total) * 1000) / 10;

  return {
    totalQuestions: total,
    answeredQuestions: answered,
    pendingQuestions: total - answered,
    completionPercentage: percentage,
    byCategory,
  };
}

// ---------- Business operations ----------

/**
 * Saves an answer for a question, only if `userEmail` is its current owner.
 *
 * @throws SurveyServiceError 400 invalid input, 403 not the owner, 404 unknown question,
 *         409 question already answered.
 */
export function answerQuestion(
  questionId: string,
  userEmail: string,
  answerText: string,
): Promise<Survey> {
  return withWriteLock(async () => {
    const email = normalizeEmail(userEmail);
    assertValidEmail(email, "userEmail");

    if (typeof questionId !== "string" || questionId.trim() === "") {
      throw new SurveyServiceError(400, "questionId is required.");
    }
    const text = typeof answerText === "string" ? answerText.trim() : "";
    if (text === "") {
      throw new SurveyServiceError(400, "Answer text cannot be empty.");
    }
    if (text.length > MAX_ANSWER_LENGTH) {
      throw new SurveyServiceError(
        400,
        `Answer text cannot exceed ${MAX_ANSWER_LENGTH} characters.`,
      );
    }

    const survey = await readSurvey();
    const question = survey.questions.find((q) => q.id === questionId);
    if (!question) throw new SurveyServiceError(404, "Question not found.");

    if (normalizeEmail(question.currentOwner) !== email) {
      throw new SurveyServiceError(403, "Only the current owner can answer this question.");
    }
    if (question.status === "answered") {
      throw new SurveyServiceError(409, "This question has already been answered.");
    }

    question.answer = text;
    question.status = "answered";
    question.answeredAt = new Date().toISOString();
    survey.progress = recalculateProgress(survey.questions);

    await writeSurvey(survey);
    return survey;
  });
}

/**
 * Transfers ownership of one pending question (`questionId`) or of all pending
 * questions in a category (`category`) that `currentOwnerEmail` owns to `newOwnerEmail`.
 * The previous owner loses ownership; every transfer is appended to the audit trail.
 *
 * @throws SurveyServiceError 400 invalid input, 403 caller is not the owner,
 *         404 unknown question/category, 409 nothing pending to delegate.
 */
export function delegateResponsibility(params: DelegateParams): Promise<DelegateResult> {
  return withWriteLock(async () => {
    const currentOwner = normalizeEmail(params.currentOwnerEmail);
    const newOwner = normalizeEmail(params.newOwnerEmail);
    assertValidEmail(currentOwner, "currentOwnerEmail");
    assertValidEmail(newOwner, "newOwnerEmail");

    if (currentOwner === newOwner) {
      throw new SurveyServiceError(400, "The new owner must be a different person.");
    }

    const hasQuestionId = typeof params.questionId === "string" && params.questionId.trim() !== "";
    const hasCategory = typeof params.category === "string" && params.category.trim() !== "";
    if (hasQuestionId === hasCategory) {
      throw new SurveyServiceError(400, "Provide exactly one of questionId or category.");
    }

    const survey = await readSurvey();
    let targets: SurveyQuestion[];

    if (hasQuestionId) {
      const question = survey.questions.find((q) => q.id === params.questionId);
      if (!question) throw new SurveyServiceError(404, "Question not found.");
      if (normalizeEmail(question.currentOwner) !== currentOwner) {
        throw new SurveyServiceError(403, "Only the current owner can delegate this question.");
      }
      if (question.status === "answered") {
        throw new SurveyServiceError(409, "An answered question cannot be delegated.");
      }
      targets = [question];
    } else {
      const category = normalizeCategory(params.category);
      const inCategory = survey.questions.filter((q) => normalizeCategory(q.category) === category);
      if (inCategory.length === 0) throw new SurveyServiceError(404, "Category not found.");

      const pending = inCategory.filter((q) => q.status === "pending");
      if (pending.length === 0) {
        throw new SurveyServiceError(409, "This category has no pending questions to delegate.");
      }

      targets = pending.filter((q) => normalizeEmail(q.currentOwner) === currentOwner);
      if (targets.length === 0) {
        throw new SurveyServiceError(
          403,
          "You do not own any pending questions in this category.",
        );
      }
    }

    const delegatedAt = new Date().toISOString();
    for (const question of targets) {
      question.delegationHistory.push({
        from: question.currentOwner,
        to: newOwner,
        delegatedAt,
      });
      question.currentOwner = newOwner;
    }
    survey.progress = recalculateProgress(survey.questions);

    await writeSurvey(survey);
    return { transferredQuestionIds: targets.map((q) => q.id), survey };
  });
}
 

// ---------- Automatic categorization ----------

/** Category assigned when no keyword matches. */
export const FALLBACK_CATEGORY = "general";

const MAX_SURVEY_QUESTIONS = 200;
const MAX_QUESTION_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 200;

/**
 * Keyword table, in priority order (earlier categories win ties).
 * Keywords are matched as word PREFIXES after lower-casing and removing accents, so
 * "budget" also matches "budgets" and "emision" also matches "emisiones".
 * Spanish keywords are plain data that let the classifier handle Spanish questions;
 * they are intentionally accent-free.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["finance", [
    "budget", "margin", "revenue", "profit", "cost", "expense", "fiscal", "cash flow", "tax",
    "invest", "financ", "debt", "loan", "earnings", "income",
    "presupuesto", "margen", "ingreso", "ganancia", "costo", "gasto", "impuesto", "inversion",
    "deuda", "flujo de caja", "utilidad",
  ]],
  ["operations", [
    "incident", "production", "process", "logistic", "supply chain", "inventory", "delivery",
    "uptime", "downtime", "capacity", "maintenance", "quality", "supplier", "operation",
    "warehouse", "throughput",
    "incidente", "produccion", "proceso", "logistica", "cadena de suministro", "inventario",
    "entrega", "capacidad", "mantenimiento", "calidad", "proveedor", "operacion",
  ]],
  ["environment", [
    "environment", "emission", "carbon", "waste", "energy", "sustainab", "recycl", "climate",
    "water", "pollution", "renewable", "biodiversity", "footprint",
    "medio ambiente", "medioambiente", "emision", "carbono", "residuo", "energia", "sostenib",
    "sustentab", "reciclaje", "clima", "contaminacion", "huella",
  ]],
  ["marketing", [
    "marketing", "campaign", "brand", "customer", "advertis", "social media", "market share",
    "promotion", "audience", "engagement", "conversion", "newsletter",
    "campana", "marca", "cliente", "publicidad", "redes sociales", "promocion", "audiencia",
    "posicionamiento",
  ]],
  ["hr", [
    "employee", "hiring", "recruit", "turnover", "training", "payroll", "headcount", "benefits",
    "talent", "onboarding", "personnel",
    "empleado", "contratacion", "reclutamiento", "rotacion", "capacitacion", "nomina",
    "dotacion", "talento", "colaborador",
  ]],
  ["legal", [
    "legal", "law", "contract", "litigation", "regulat", "lawsuit", "intellectual property",
    "patent", "compliance",
    "contrato", "litigio", "regulacion", "normativa", "propiedad intelectual", "patente",
    "cumplimiento",
  ]],
  ["it", [
    "software", "server", "database", "cyber", "network", "cloud", "infrastructure", "hardware",
    "data center",
    "servidor", "base de datos", "ciberseguridad", "infraestructura", "nube",
  ]],
];

/** Lower-cases and strips accents so matching is case- and accent-insensitive. */
function normalizeForMatching(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Escapes a literal string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pre-compiled word-prefix patterns, built once at module load. */
const CATEGORY_MATCHERS = CATEGORY_KEYWORDS.map(([category, keywords]) => ({
  category,
  patterns: keywords.map((keyword) => new RegExp(`\\b${escapeRegExp(normalizeForMatching(keyword))}`)),
}));

/**
 * Classifies one question by keyword matching.
 * The category with the most keyword hits wins; ties go to the earlier category in
 * {@link CATEGORY_KEYWORDS}; no hit yields {@link FALLBACK_CATEGORY}.
 * Complexity: O(k * L) for k keywords and a question of length L.
 *
 * @param text Question text.
 * @returns A category key (e.g. "finance").
 */
export function categorizeQuestion(text: string): string {
  const normalized = normalizeForMatching(text);
  let bestCategory = FALLBACK_CATEGORY;
  let bestScore = 0;

  for (const { category, patterns } of CATEGORY_MATCHERS) {
    const score = patterns.reduce((hits, pattern) => hits + (pattern.test(normalized) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return bestCategory;
}

/** Metadata required to create a survey. */
export interface CreateSurveyMetadata {
  title: string;
  /** Email of the single person the survey is addressed to (initial owner of every question). */
  initialRecipient: string;
  /** Replace the current survey even if it already contains answers. */
  force?: boolean;
}

/**
 * Creates a survey from raw question texts, categorizing each question automatically,
 * and stores it as the current survey (`data.json`).
 *
 * @param questions Question texts (1 to 200, each up to 1000 characters).
 * @param metadata Title, initial recipient and the optional `force` flag.
 * @returns The stored survey with progress already calculated.
 * @throws SurveyServiceError 400 invalid input, 409 the current survey has answers and
 *         `force` is not set.
 */
export function createSurvey(
  questions: readonly string[],
  metadata: CreateSurveyMetadata,
): Promise<Survey> {
  return withWriteLock(async () => {
    const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
    if (title === "" || title.length > MAX_TITLE_LENGTH) {
      throw new SurveyServiceError(
        400,
        `title is required and must be at most ${MAX_TITLE_LENGTH} characters.`,
      );
    }

    const recipient = normalizeEmail(metadata.initialRecipient);
    assertValidEmail(recipient, "initialRecipient");

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new SurveyServiceError(400, "At least one question is required.");
    }
    if (questions.length > MAX_SURVEY_QUESTIONS) {
      throw new SurveyServiceError(400, `A survey cannot exceed ${MAX_SURVEY_QUESTIONS} questions.`);
    }

    const texts = questions.map((question) => (typeof question === "string" ? question.trim() : ""));
    const invalidIndex = texts.findIndex(
      (text) => text === "" || text.length > MAX_QUESTION_LENGTH,
    );
    if (invalidIndex !== -1) {
      throw new SurveyServiceError(
        400,
        `Question ${invalidIndex + 1} must be 1-${MAX_QUESTION_LENGTH} characters long.`,
      );
    }

    // Never silently destroy collected answers.
    if (metadata.force !== true) {
      try {
        const current = await readSurvey();
        if (current.questions.some((question) => question.status === "answered")) {
          throw new SurveyServiceError(
            409,
            "The current survey already has answers. Use force to replace it.",
          );
        }
      } catch (error) {
        if (error instanceof SurveyServiceError) throw error;
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }

    const surveyQuestions: SurveyQuestion[] = texts.map((text, index) => ({
      id: `q-${String(index + 1).padStart(3, "0")}`,
      category: categorizeQuestion(text),
      text,
      originalAssignee: recipient,
      currentOwner: recipient,
      status: "pending",
      answer: null,
      answeredAt: null,
      delegationHistory: [],
    }));

    const survey: Survey = {
      id: `survey-${crypto.randomUUID().slice(0, 8)}`,
      title,
      initialRecipient: recipient,
      createdAt: new Date().toISOString(),
      progress: recalculateProgress(surveyQuestions),
      questions: surveyQuestions,
    };

    await writeSurvey(survey);
    return survey;
  });
}