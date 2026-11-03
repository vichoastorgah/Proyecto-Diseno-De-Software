/**
 * @module services/emailService
 * Personalized voting-invitation emails.
 *
 * Delivery modes:
 * 1. `smtp`      - Real delivery through `nodemailer`. Used when BOTH `SMTP_USER` and
 *                  `SMTP_PASS` are defined in the environment (e.g. in `.env`).
 * 2. `simulated` - Fallback used when either credential is missing. Nothing leaves the
 *                  machine: the complete message (recipient, subject, link, attachment
 *                  name) is printed to the console so the flow can still be demonstrated
 *                  offline. The returned result reports `mode: "simulated"`.
 *
 * Environment variables:
 * - SMTP_USER, SMTP_PASS     Credentials (both required for real delivery).
 * - SMTP_HOST                Default `smtp.gmail.com`.
 * - SMTP_PORT                Default `587`.
 * - SMTP_SECURE              `true` for implicit TLS. Defaults to `true` only on port 465.
 * - SMTP_FROM                Sender address. Defaults to `SMTP_USER`.
 * - VOTE_BASE_URL            Base URL of the voting page. Default `http://localhost:5173/vote`.
 * - DEFAULT_EMAIL_LANGUAGE   `en` or `es`. Default `en`.
 *
 * Email copy is stored locally (no external translation API).
 */
// @deno-types="npm:@types/nodemailer@6.4.17"
import nodemailer from "npm:nodemailer@6.9.16";
import { fromFileUrl } from "jsr:@std/path@^1";

/** Languages supported by the email templates. */
export type EmailLanguage = "en" | "es";

/** Minimum recipient data needed to personalize a message. */
export interface EmailRecipient {
  email: string;
  name: string;
  /** Free-text gender used for the salutation (e.g. "male", "female", "other"). */
  gender?: string;
  /** ISO timestamp after which the voting link stops working. */
  tokenExpiresAt?: string;
}

/** Optional per-message settings. */
export interface EmailOptions {
  /** Language of the message. Defaults to `DEFAULT_EMAIL_LANGUAGE` or `en`. */
  language?: EmailLanguage;
  /** Title of the motion, shown in the subject and body. */
  motionTitle?: string;
  /** Name shown for the attachment (defaults to the file name on disk). */
  attachmentName?: string;
}

/** How a message was handled. */
export type DeliveryMode = "smtp" | "simulated";

/** Outcome of one send operation. */
export interface EmailDeliveryResult {
  mode: DeliveryMode;
  recipient: string;
  /** Provider message id (only for `smtp`). */
  messageId?: string;
}

/** Localized copy of one language. */
interface EmailTemplate {
  subject: (motionTitle?: string) => string;
  salutation: Record<"male" | "female" | "neutral", (name: string) => string>;
  intro: (motionTitle?: string) => string;
  instruction: string;
  expiry: (date: string) => string;
  attachmentNote: string;
  ignoreNote: string;
  locale: string;
}

const TEMPLATES: Record<EmailLanguage, EmailTemplate> = {
  en: {
    subject: (title) => (title ? `Your voting link: ${title}` : "Your personal voting link"),
    salutation: {
      male: (name) => `Dear Mr. ${name}`,
      female: (name) => `Dear Ms. ${name}`,
      neutral: (name) => `Dear ${name}`,
    },
    intro: (title) =>
      title ? `You have been invited to vote on: "${title}".` : "You have been invited to vote.",
    instruction: "Use your personal, single-use link:",
    expiry: (date) => `This link is valid until ${date}.`,
    attachmentNote: "Supporting documents are attached to this message.",
    ignoreNote: "Do not share this link: it identifies you as a voter.",
    locale: "en-US",
  },
  es: {
    subject: (title) => (title ? `Tu enlace de votación: ${title}` : "Tu enlace personal de votación"),
    salutation: {
      male: (name) => `Estimado Sr. ${name}`,
      female: (name) => `Estimada Sra. ${name}`,
      neutral: (name) => `Estimado/a ${name}`,
    },
    intro: (title) =>
      title ? `Has sido invitado/a a votar en: "${title}".` : "Has sido invitado/a a votar.",
    instruction: "Usa tu enlace personal de un solo uso:",
    expiry: (date) => `Este enlace es válido hasta el ${date}.`,
    attachmentNote: "Los documentos de respaldo van adjuntos a este mensaje.",
    ignoreNote: "No compartas este enlace: te identifica como votante.",
    locale: "es-CL",
  },
};

/** Cached SMTP transporter (created lazily on first real send). */
let cachedTransporter: nodemailer.Transporter | null = null;

/** True when both SMTP credentials are present in the environment. */
export function isSmtpConfigured(): boolean {
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  return Boolean(user && pass);
}

/** Builds (once) the nodemailer transporter from environment variables. */
function getTransporter(): nodemailer.Transporter {
  if (cachedTransporter) return cachedTransporter;

  const port = Number(Deno.env.get("SMTP_PORT") ?? 587);
  const secureFlag = Deno.env.get("SMTP_SECURE");
  const secure = secureFlag === undefined ? port === 465 : secureFlag.toLowerCase() === "true";

  cachedTransporter = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com",
    port,
    secure,
    auth: {
      user: Deno.env.get("SMTP_USER") as string,
      pass: Deno.env.get("SMTP_PASS") as string,
    },
  });
  return cachedTransporter;
}

/** Resolves the message language from options and environment. */
function resolveLanguage(options?: EmailOptions): EmailLanguage {
  if (options?.language === "en" || options?.language === "es") return options.language;
  return Deno.env.get("DEFAULT_EMAIL_LANGUAGE") === "es" ? "es" : "en";
}

/** Maps free-text gender to a salutation bucket. */
function genderBucket(gender: string | undefined): "male" | "female" | "neutral" {
  switch ((gender ?? "").trim().toLowerCase()) {
    case "male":
    case "m":
    case "masculino":
      return "male";
    case "female":
    case "f":
    case "femenino":
      return "female";
    default:
      return "neutral";
  }
}

/** Escapes text for safe insertion into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds the personalized salutation from the recipient's gender and name. */
export function buildGreeting(recipient: EmailRecipient, language: EmailLanguage): string {
  return TEMPLATES[language].salutation[genderBucket(recipient.gender)](recipient.name);
}

/** Builds the voting URL that carries the single-use token. */
export function buildVotingLink(token: string): string {
  const baseUrl = Deno.env.get("VOTE_BASE_URL") ?? "http://localhost:5173/vote";
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

/** Plain-text and HTML bodies plus subject for one recipient. */
interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Renders the localized message. Pure function. */
function renderEmail(
  recipient: EmailRecipient,
  token: string,
  hasAttachment: boolean,
  language: EmailLanguage,
  motionTitle?: string,
): RenderedEmail {
  const template = TEMPLATES[language];
  const greeting = buildGreeting(recipient, language);
  const link = buildVotingLink(token);
  const expiryLine = recipient.tokenExpiresAt
    ? template.expiry(new Date(recipient.tokenExpiresAt).toLocaleString(template.locale))
    : null;

  const textLines = [
    `${greeting},`,
    "",
    template.intro(motionTitle),
    template.instruction,
    link,
    ...(expiryLine ? ["", expiryLine] : []),
    ...(hasAttachment ? ["", template.attachmentNote] : []),
    "",
    template.ignoreNote,
  ];

  const htmlParts = [
    `<p>${escapeHtml(greeting)},</p>`,
    `<p>${escapeHtml(template.intro(motionTitle))}</p>`,
    `<p>${escapeHtml(template.instruction)}<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    ...(expiryLine ? [`<p>${escapeHtml(expiryLine)}</p>`] : []),
    ...(hasAttachment ? [`<p>${escapeHtml(template.attachmentNote)}</p>`] : []),
    `<p><small>${escapeHtml(template.ignoreNote)}</small></p>`,
  ];

  return {
    subject: template.subject(motionTitle),
    text: textLines.join("\n"),
    html: htmlParts.join("\n"),
  };
}

/** Normalizes an attachment location (path or file URL) to a file-system path. */
function toFilePath(attachment: string | URL): string {
  return attachment instanceof URL ? fromFileUrl(attachment) : attachment;
}

/** Returns the last path segment (works with both `/` and `\` separators). */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Sends one personalized voting invitation.
 *
 * With SMTP credentials configured the message is delivered through nodemailer;
 * otherwise it is printed to the console (see the module documentation).
 *
 * @param voter Recipient data (email, name, gender, token expiry).
 * @param token Single-use token embedded in the voting link.
 * @param attachmentPath Optional file to attach (absolute path or `file:` URL).
 * @param options Optional language and motion title.
 * @returns How the message was handled.
 * @throws If the attachment cannot be read or the SMTP server rejects the message.
 */
export async function sendRealPersonalizedEmail(
  voter: EmailRecipient,
  token: string,
  attachmentPath?: string | URL,
  options?: EmailOptions,
): Promise<EmailDeliveryResult> {
  const language = resolveLanguage(options);
  const filePath = attachmentPath ? toFilePath(attachmentPath) : undefined;

  if (filePath) {
    // Fail early (and clearly) if the file is missing, in both modes.
    await Deno.stat(filePath);
  }

  const message = renderEmail(voter, token, Boolean(filePath), language, options?.motionTitle);

  if (!isSmtpConfigured()) {
    console.log(
      [
        "---------- [SIMULATED EMAIL: SMTP_USER / SMTP_PASS not set] ----------",
        `To: ${voter.email}`,
        `Subject: ${message.subject}`,
        `Attachment: ${filePath ? (options?.attachmentName ?? fileNameOf(filePath)) : "none"}`,
        "",
        message.text,
        "----------------------------------------------------------------------",
      ].join("\n"),
    );
    return { mode: "simulated", recipient: voter.email };
  }

  const info = await getTransporter().sendMail({
    from: Deno.env.get("SMTP_FROM") ?? Deno.env.get("SMTP_USER"),
    to: voter.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: filePath
      ? [{ filename: options?.attachmentName ?? fileNameOf(filePath), path: filePath }]
      : [],
  });

  return { mode: "smtp", recipient: voter.email, messageId: info.messageId };
}