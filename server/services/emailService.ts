/**
 * @module services/emailService
 * Personalized emails (voting invitations and survey assignments) in English or Spanish.
 *
 * Delivery is abstracted behind {@link Mailer}:
 * - `smtp`      real delivery through nodemailer, used when SMTP_USER and SMTP_PASS are set.
 * - `simulated` nothing leaves the machine; the message is printed to the server console
 *               so the whole flow can be demonstrated offline (including the voting link).
 * Tests inject {@link createCapturingMailer} to inspect the rendered messages.
 *
 * Environment (SMTP mode): SMTP_USER, SMTP_PASS, SMTP_HOST (default smtp.gmail.com),
 * SMTP_PORT (587), SMTP_SECURE (true only on port 465 by default), SMTP_FROM (SMTP_USER).
 * Email copy is stored locally: no external translation API.
 */
// @deno-types="@types/nodemailer"
import nodemailer from "nodemailer";
import { Buffer } from "node:buffer";
import type { Gender } from "./csvService.ts";

export type EmailLanguage = "en" | "es";
export type DeliveryMode = "smtp" | "simulated";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Attachment bytes are loaded from the file store (works without a local disk). */
  attachments: { filename: string; content: Uint8Array }[];
}

export interface Mailer {
  readonly mode: DeliveryMode;
  send(email: OutgoingEmail): Promise<void>;
}

// ---------- Mailers ----------

/** Real SMTP delivery. */
function createSmtpMailer(env: Record<string, string | undefined>): Mailer {
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE.toLowerCase() === "true";
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST ?? "smtp.gmail.com",
    port,
    secure,
    auth: { user: env.SMTP_USER as string, pass: env.SMTP_PASS as string },
  });
  const from = env.SMTP_FROM ?? env.SMTP_USER;
  return {
    mode: "smtp",
    async send(email) {
      await transporter.sendMail({
        from,
        ...email,
        attachments: email.attachments.map((file) => ({ filename: file.filename, content: Buffer.from(file.content) })),
      });
    },
  };
}

/** Prints the message to the console instead of sending it. */
function createConsoleMailer(): Mailer {
  return {
    mode: "simulated",
    send(email) {
      console.log(
        [
          "---------- [SIMULATED EMAIL: SMTP_USER / SMTP_PASS not set] ----------",
          `To: ${email.to}`,
          `Subject: ${email.subject}`,
          `Attachments: ${email.attachments.map((a) => a.filename).join(", ") || "none"}`,
          "",
          email.text,
          "----------------------------------------------------------------------",
        ].join("\n"),
      );
      return Promise.resolve();
    },
  };
}

/** Picks SMTP when both credentials are configured, the console simulation otherwise. */
export function createMailer(env: Record<string, string | undefined> = Deno.env.toObject()): Mailer {
  return env.SMTP_USER && env.SMTP_PASS ? createSmtpMailer(env) : createConsoleMailer();
}

/** Test double: keeps every message in memory. `failFor` simulates rejected recipients. */
export function createCapturingMailer(failFor: readonly string[] = []): Mailer & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    mode: "simulated",
    sent,
    send(email) {
      if (failFor.includes(email.to)) return Promise.reject(new Error("Rejected by test mailer."));
      sent.push(email);
      return Promise.resolve();
    },
  };
}

// ---------- Templates ----------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const LOCALES: Record<EmailLanguage, string> = { en: "en-US", es: "es-CL" };

/** Gender-aware salutation (the CSV gender personalizes the message). */
export function buildGreeting(name: string, gender: Gender | string, language: EmailLanguage): string {
  if (language === "es") {
    if (gender === "male") return `Estimado Sr. ${name}`;
    if (gender === "female") return `Estimada Sra. ${name}`;
    return `Estimado/a ${name}`;
  }
  if (gender === "male") return `Dear Mr. ${name}`;
  if (gender === "female") return `Dear Ms. ${name}`;
  return `Dear ${name}`;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Wraps paragraphs in a minimal, client-safe HTML layout. */
function htmlLayout(paragraphs: string[], link: { href: string; label: string }, footer: string): string {
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:560px">',
    ...paragraphs,
    `<p style="margin:24px 0"><a href="${escapeHtml(link.href)}" style="background:#1d4ed8;color:#ffffff;` +
    `padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p>`,
    `<p style="font-size:13px;color:#4b5563">${escapeHtml(link.href)}</p>`,
    `<p style="font-size:12px;color:#6b7280">${escapeHtml(footer)}</p>`,
    "</div>",
  ].join("\n");
}

export interface InvitationContent {
  name: string;
  gender: Gender | string;
  language: EmailLanguage;
  electionTitle: string;
  motionTitles: string[];
  link: string;
  /** ISO timestamp, or null when the link never expires. */
  expiresAt: string | null;
  attachmentCount: number;
}

/** Renders a voting invitation. Pure function. */
export function renderInvitation(content: InvitationContent): RenderedEmail {
  const es = content.language === "es";
  const greeting = buildGreeting(content.name, content.gender, content.language);
  const expiry = content.expiresAt
    ? new Date(content.expiresAt).toLocaleString(LOCALES[content.language], { timeZone: "America/Santiago" })
    : null;

  const subject = es ? `Tu enlace de votación: ${content.electionTitle}` : `Your voting link: ${content.electionTitle}`;
  const intro = es
    ? `Te invitamos a participar en la votación "${content.electionTitle}".`
    : `You are invited to take part in the vote "${content.electionTitle}".`;
  const motionsHeading = es
    ? (content.motionTitles.length === 1 ? "Moción a votar:" : `Mociones a votar (${content.motionTitles.length}):`)
    : (content.motionTitles.length === 1 ? "Motion on the ballot:" : `Motions on the ballot (${content.motionTitles.length}):`);
  const instruction = es
    ? "Usa tu enlace personal. Solo puedes votar una vez y tu voto es secreto."
    : "Use your personal link. You can vote only once and your vote is secret.";
  const expiryLine = expiry ? (es ? `El enlace es válido hasta: ${expiry}` : `The link is valid until: ${expiry}`) : null;
  const attachmentLine = content.attachmentCount > 0
    ? (es ? "Los documentos de respaldo van adjuntos a este correo." : "Supporting documents are attached to this email.")
    : null;
  const footer = es
    ? "No compartas este enlace: te identifica como votante. Si no esperabas este correo, ignóralo."
    : "Do not share this link: it identifies you as a voter. If you did not expect this email, ignore it.";
  const button = es ? "Ir a votar" : "Go to the ballot";

  const text = [
    `${greeting},`,
    "",
    intro,
    "",
    motionsHeading,
    ...content.motionTitles.map((title, index) => `  ${index + 1}. ${title}`),
    "",
    instruction,
    content.link,
    ...(expiryLine ? ["", expiryLine] : []),
    ...(attachmentLine ? ["", attachmentLine] : []),
    "",
    footer,
  ].join("\n");

  const html = htmlLayout(
    [
      `<p>${escapeHtml(greeting)},</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<p>${escapeHtml(motionsHeading)}</p>`,
      `<ol>${content.motionTitles.map((title) => `<li>${escapeHtml(title)}</li>`).join("")}</ol>`,
      `<p>${escapeHtml(instruction)}</p>`,
      ...(expiryLine ? [`<p>${escapeHtml(expiryLine)}</p>`] : []),
      ...(attachmentLine ? [`<p>${escapeHtml(attachmentLine)}</p>`] : []),
    ],
    { href: content.link, label: button },
    footer,
  );

  return { subject, text, html };
}

export interface SurveyNoticeContent {
  language: EmailLanguage;
  surveyTitle: string;
  questionCount: number;
  link: string;
  /** `initial`: the survey was addressed to the recipient; `delegated`: questions were handed over. */
  kind: "initial" | "delegated";
  fromEmail?: string;
}

/** Renders the notice sent to a survey recipient or to a new question owner. Pure function. */
export function renderSurveyNotice(content: SurveyNoticeContent): RenderedEmail {
  const es = content.language === "es";
  const n = content.questionCount;
  const subject = es ? `Cuestionario asignado: ${content.surveyTitle}` : `Survey assigned to you: ${content.surveyTitle}`;
  const body = content.kind === "initial"
    ? (es
      ? `Se te asignó el cuestionario "${content.surveyTitle}" (${n} preguntas). Puedes responderlas o delegarlas a otras personas de tu organización.`
      : `The survey "${content.surveyTitle}" (${n} questions) has been assigned to you. You can answer the questions or delegate them to colleagues.`)
    : (es
      ? `${content.fromEmail ?? "Una persona"} te delegó ${n} ${n === 1 ? "pregunta" : "preguntas"} del cuestionario "${content.surveyTitle}". Ahora eres responsable de responderlas.`
      : `${content.fromEmail ?? "Someone"} delegated ${n} ${n === 1 ? "question" : "questions"} of the survey "${content.surveyTitle}" to you. You are now responsible for answering them.`);
  const signIn = es
    ? "Inicia sesión con tu cuenta de Google corporativa para continuar."
    : "Sign in with your Google account to continue.";
  const footer = es ? "Mensaje automático del Sistema de Votación y Cuestionarios." : "Automatic message from the Voting & Survey System.";
  const button = es ? "Abrir cuestionario" : "Open survey";

  return {
    subject,
    text: [body, "", signIn, content.link, "", footer].join("\n"),
    html: htmlLayout([`<p>${escapeHtml(body)}</p>`, `<p>${escapeHtml(signIn)}</p>`], { href: content.link, label: button }, footer),
  };
}
