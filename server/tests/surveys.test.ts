import { assertEquals, assertMatch } from "@std/assert";
import { categorizeQuestion } from "../services/surveyService.ts";
import { ADMIN, createTestEnv, type TestEnv } from "./testUtils.ts";

const RECIPIENT = "ceo@example.com";
const CFO = "cfo@example.com";
const COO = "coo@example.com";

interface Question {
  id: string;
  category: string;
  currentOwner: string;
  originalAssignee: string;
  status: string;
  answer: string | null;
  delegationHistory: { from: string; to: string }[];
}

interface Survey {
  id: string;
  viewerRole: string;
  questions: Question[];
  hiddenQuestionCount: number;
  progress: {
    totalQuestions: number;
    answeredQuestions: number;
    completionPercentage: number;
    byCategory: Record<string, { total: number; answered: number }>;
    pendingByOwner: Record<string, number>;
  };
}

const QUESTIONS = [
  "What is the budget for 2027?",
  "How many incidents affected production?",
  "What are our carbon emissions?",
  "Which marketing campaign performed best?",
  "¿Cuál fue el margen de utilidad?",
];

async function createSurvey(env: TestEnv): Promise<Survey> {
  const admin = await env.sessionFor(ADMIN);
  const response = await env.request("POST", "/api/surveys", {
    token: admin,
    json: { title: "Annual survey", initialRecipient: RECIPIENT, questions: QUESTIONS, lang: "es" },
  });
  assertEquals(response.status, 201);
  return response.body.survey as Survey;
}

Deno.test("surveys: automatic categorization (English and Spanish)", () => {
  assertEquals(categorizeQuestion("What is the budget for 2027?"), "finance");
  assertEquals(categorizeQuestion("How many incidents affected production?"), "operations");
  assertEquals(categorizeQuestion("¿Cuántas emisiones de carbono generamos?"), "environment");
  assertEquals(categorizeQuestion("Which marketing campaign performed best?"), "marketing");
  assertEquals(categorizeQuestion("How many employees did we hire?"), "hr");
  assertEquals(categorizeQuestion("Favourite colour?"), "general");
});

Deno.test("surveys: creation assigns every question to the single recipient and notifies them", async () => {
  const env = await createTestEnv();
  try {
    const survey = await createSurvey(env);
    assertEquals(survey.questions.map((question) => question.category), ["finance", "operations", "environment", "marketing", "finance"]);
    assertEquals(new Set(survey.questions.map((question) => question.currentOwner)), new Set([RECIPIENT]));
    assertEquals(survey.progress.byCategory.finance, { total: 2, answered: 0, percentage: 0 } as never);
    const notice = env.mailer.sent.find((mail) => mail.to === RECIPIENT)!;
    assertMatch(notice.subject, /Cuestionario asignado/);
    assertMatch(notice.text, new RegExp(`/surveys/${survey.id}`));

    const preview = await env.request("POST", "/api/surveys/categorize", {
      token: await env.sessionFor(ADMIN),
      json: { questions: ["Budget?", "Recycling?"] },
    });
    assertEquals((preview.body.questions as { category: string }[]).map((q) => q.category), ["finance", "environment"]);

    const invalid = await env.request("POST", "/api/surveys", {
      token: await env.sessionFor(ADMIN),
      json: { title: "x", initialRecipient: "not-an-email", questions: ["q"] },
    });
    assertEquals(invalid.status, 400);
  } finally {
    await env.cleanup();
  }
});

Deno.test("surveys: delegation transfers responsibility and only the owner can answer", async () => {
  const env = await createTestEnv();
  try {
    const survey = await createSurvey(env);
    const ceo = await env.sessionFor(RECIPIENT);
    const cfo = await env.sessionFor(CFO);
    const budget = survey.questions[0];

    // Only the owner can answer.
    const notOwner = await env.request("POST", `/api/surveys/${survey.id}/questions/${budget.id}/answer`, {
      token: cfo, json: { answer: "1M" },
    });
    // The CFO is not a participant yet (and not in an allow-list): the session is not accepted.
    assertEquals(notOwner.status, 401);

    // CEO delegates the whole finance category to the CFO.
    const delegated = await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: ceo, json: { category: "finance", newOwnerEmail: CFO },
    });
    assertEquals(delegated.status, 200);
    assertEquals((delegated.body.transferredQuestionIds as string[]).length, 2);
    const notice = env.mailer.sent.find((mail) => mail.to === CFO)!;
    assertMatch(notice.text, /delegated 2 questions/);

    // The CEO lost the responsibility: answering now fails.
    const ceoAnswer = await env.request("POST", `/api/surveys/${survey.id}/questions/${budget.id}/answer`, {
      token: ceo, json: { answer: "Too late" },
    });
    assertEquals([ceoAnswer.status, ceoAnswer.body.code], [403, "NOT_QUESTION_OWNER"]);

    // Exactly one responsible per question, with the audit trail.
    const owners = await env.db.all<{ current_owner: string }>("SELECT current_owner FROM survey_questions WHERE category = 'finance'");
    assertEquals(owners.map((row) => row.current_owner), [CFO, CFO]);

    // The CFO re-delegates one question to the COO, then answers the other one.
    const second = survey.questions[4];
    const redelegate = await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: cfo, json: { questionIds: [second.id], newOwnerEmail: COO },
    });
    assertEquals(redelegate.status, 200);
    const answer = await env.request("POST", `/api/surveys/${survey.id}/questions/${budget.id}/answer`, {
      token: cfo, json: { answer: "USD 1.2M" },
    });
    assertEquals(answer.status, 200);
    const twice = await env.request("POST", `/api/surveys/${survey.id}/questions/${budget.id}/answer`, {
      token: cfo, json: { answer: "Changed" },
    });
    assertEquals([twice.status, twice.body.code], [409, "QUESTION_ALREADY_ANSWERED"]);

    // Answered questions cannot be delegated; delegating to oneself is rejected.
    const lockedDelegation = await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: cfo, json: { questionIds: [budget.id], newOwnerEmail: COO },
    });
    assertEquals(lockedDelegation.status, 409);
    const self = await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: ceo, json: { questionIds: [survey.questions[1].id], newOwnerEmail: RECIPIENT },
    });
    assertEquals([self.status, self.body.code], [400, "DELEGATE_TO_SELF"]);

    // All-or-nothing: one foreign question blocks the whole batch.
    const mixed = await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: ceo, json: { questionIds: [survey.questions[1].id, second.id], newOwnerEmail: CFO },
    });
    assertEquals(mixed.status, 403);
    const stillCeo = await env.db.all<{ current_owner: string }>("SELECT current_owner FROM survey_questions WHERE id = $1", survey.questions[1].id);
    assertEquals(stillCeo[0].current_owner, RECIPIENT);

    const history = await env.db.all("SELECT from_email, to_email FROM survey_delegations ORDER BY id");
    assertEquals(history.length, 3);
  } finally {
    await env.cleanup();
  }
});

Deno.test("surveys: consolidated view for the recipient, restricted view for delegates", async () => {
  const env = await createTestEnv();
  try {
    const survey = await createSurvey(env);
    const ceo = await env.sessionFor(RECIPIENT);
    await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: ceo, json: { questionIds: [survey.questions[2].id], newOwnerEmail: COO },
    });
    const coo = await env.sessionFor(COO);
    await env.request("POST", `/api/surveys/${survey.id}/questions/${survey.questions[2].id}/answer`, {
      token: coo, json: { answer: "120 t CO2" },
    });

    const recipientView = (await env.request("GET", `/api/surveys/${survey.id}`, { token: ceo })).body as unknown as Survey;
    assertEquals(recipientView.viewerRole, "recipient");
    assertEquals(recipientView.questions.length, 5);
    assertEquals(recipientView.questions[2].answer, "120 t CO2");
    assertEquals(recipientView.progress.answeredQuestions, 1);
    assertEquals(recipientView.progress.completionPercentage, 20);
    assertEquals(recipientView.progress.pendingByOwner, { [RECIPIENT]: 4 });

    const delegateView = (await env.request("GET", `/api/surveys/${survey.id}`, { token: coo })).body as unknown as Survey;
    assertEquals(delegateView.viewerRole, "participant");
    assertEquals(delegateView.questions.length, 1);
    assertEquals(delegateView.hiddenQuestionCount, 4);
    assertEquals(delegateView.progress.totalQuestions, 5);

    const list = await env.request("GET", "/api/surveys", { token: coo });
    assertEquals((list.body.surveys as { id: string }[]).map((item) => item.id), [survey.id]);

    // Someone unrelated cannot see it (but can sign in only if allowed: here, a session is forged for the test).
    const stranger = await env.sessionFor("stranger@example.com");
    assertEquals((await env.request("GET", `/api/surveys/${survey.id}`, { token: stranger })).status, 401);
    assertEquals((await env.request("GET", `/api/surveys/${survey.id}`)).status, 401);
  } finally {
    await env.cleanup();
  }
});

Deno.test("surveys: demo impersonation is limited to admins when enabled", async () => {
  const env = await createTestEnv({ demoSurveyIdentity: true, allowedEmails: ["member@example.com"] });
  try {
    const survey = await createSurvey(env);
    const admin = await env.sessionFor(ADMIN);
    const asCeo = await env.request("GET", `/api/surveys/${survey.id}`, { token: admin, headers: { "X-Act-As": RECIPIENT } });
    assertEquals((asCeo.body as unknown as Survey).viewerRole, "recipient");

    const member = await env.sessionFor("member@example.com");
    const ignored = await env.request("GET", `/api/surveys/${survey.id}`, { token: member, headers: { "X-Act-As": RECIPIENT } });
    assertEquals(ignored.status, 404);
  } finally {
    await env.cleanup();
  }

  const disabled = await createTestEnv({ demoSurveyIdentity: false });
  try {
    const survey = await createSurvey(disabled);
    const admin = await disabled.sessionFor(ADMIN);
    const response = await disabled.request("GET", `/api/surveys/${survey.id}`, { token: admin, headers: { "X-Act-As": RECIPIENT } });
    assertEquals((response.body as unknown as Survey).viewerRole, "admin");
  } finally {
    await disabled.cleanup();
  }
});
