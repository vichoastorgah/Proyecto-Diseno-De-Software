/**
 * @module context
 * Dependencies shared by the services. Built once in `server.ts` (or by each test).
 */
import type { AppConfig } from "./config.ts";
import type { Database } from "./db/database.ts";
import type { Mailer } from "./services/emailService.ts";

export interface ServiceContext {
  db: Database;
  config: AppConfig;
  mailer: Mailer;
}
