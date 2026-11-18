/**
 * @module context
 * Dependencies shared by the services. Built once in `server.ts` (or by each test).
 */
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/database.ts";
import type { Mailer } from "./services/emailService.ts";
import { createLocalFileStore, createSupabaseFileStore, type FileStore } from "./services/fileStore.ts";

export interface ServiceContext {
  db: Db;
  config: AppConfig;
  mailer: Mailer;
  files: FileStore;
}

/** Supabase Storage when fully configured, the local uploads folder otherwise. */
export function createFileStore(config: AppConfig): FileStore {
  if (config.supabaseUrl && config.supabaseServiceKey) {
    return createSupabaseFileStore({
      url: config.supabaseUrl,
      serviceKey: config.supabaseServiceKey,
      bucket: config.supabaseBucket,
    });
  }
  return createLocalFileStore(config.uploadsDir);
}
