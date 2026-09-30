import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { prisma } from "../lib/prisma";

const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

function getDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.trim() || raw.trim().startsWith("file:")) {
    // No silent fallback: a missing DATABASE_URL must fail loudly rather than
    // quietly connecting to whatever database happened to be hardcoded here.
    throw new Error(
      "DATABASE_URL is not set. Configure it in backend/.env (PostgreSQL connection string)."
    );
  }
  return raw.trim();
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  PORT: Number(optional("PORT", "4000")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:5173"),

  APIFY_API_URL: optional("APIFY_API_URL"),
  APIFY_API_KEY: optional("APIFY_API_KEY") || optional("APIFY_API_URL").match(/[?&]token=([^&]+)/)?.[1] || "",
  APIFY_METHOD: (optional("APIFY_METHOD", "POST").toUpperCase() as "GET" | "POST"),
  APIFY_INPUT_TEMPLATE: optional("APIFY_INPUT_TEMPLATE", '{"searches":["{{keyword}}"]}'),
  APIFY_QUERY_PARAMS: optional("APIFY_QUERY_PARAMS"),
  APIFY_TIMEOUT_MS: Number(optional("APIFY_TIMEOUT_MS", "120000")),

  AI_API_URL: optional("AI_API_URL", "https://api.mistral.ai/v1/chat/completions"),
  AI_API_KEY: optional("AI_API_KEY") || optional("MISTRAL_API_KEY"),
  AI_MODEL: optional("AI_MODEL", "open-mistral-7b"),
  AI_CONCURRENCY: Number(optional("AI_CONCURRENCY", "3")),

  SMTP_HOST: optional("SMTP_HOST"),
  SMTP_PORT: optional("SMTP_PORT", "587"),
  SMTP_USER: optional("SMTP_USER") || optional("GMAIL_USER"),
  SMTP_PASS: optional("SMTP_PASS") || optional("GMAIL_PASS"),
  GMAIL_USER: optional("GMAIL_USER") || optional("SMTP_USER"),
  GMAIL_PASS: optional("GMAIL_PASS") || optional("SMTP_PASS"),
  MAIL_FROM: optional("MAIL_FROM"),
  ALERT_EMAIL: optional("ALERT_EMAIL"),

  SERPER_API_KEY: optional("SERPER_API_KEY") || optional("SEARCHAPI_KEY"),
  SEARCHAPI_KEY: optional("SEARCHAPI_KEY") || optional("SERPER_API_KEY"),
  MONGODB_URI: optional("MONGODB_URI"),
  MONGODB_DB: optional("MONGODB_DB", "brandmonitor"),
  DATABASE_URL: getDatabaseUrl(),
};

export async function refreshEnvFromDisk() {
  // 1. Read from local .env if available
  try {
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf-8");
      const parsed = dotenv.parse(raw);
      if (parsed.APIFY_API_URL !== undefined) { env.APIFY_API_URL = parsed.APIFY_API_URL.trim(); process.env.APIFY_API_URL = env.APIFY_API_URL; }
      if (parsed.APIFY_API_KEY !== undefined) { env.APIFY_API_KEY = parsed.APIFY_API_KEY.trim(); process.env.APIFY_API_KEY = env.APIFY_API_KEY; }
      if (parsed.AI_API_URL !== undefined) { env.AI_API_URL = parsed.AI_API_URL.trim(); process.env.AI_API_URL = env.AI_API_URL; }
      if (parsed.AI_API_KEY !== undefined) { env.AI_API_KEY = parsed.AI_API_KEY.trim(); process.env.AI_API_KEY = env.AI_API_KEY; }
      if (parsed.MISTRAL_API_KEY !== undefined && !parsed.AI_API_KEY) { env.AI_API_KEY = parsed.MISTRAL_API_KEY.trim(); process.env.AI_API_KEY = env.AI_API_KEY; }
      if (parsed.AI_MODEL !== undefined) { env.AI_MODEL = parsed.AI_MODEL.trim(); process.env.AI_MODEL = env.AI_MODEL; }
      if (parsed.SMTP_HOST !== undefined) { env.SMTP_HOST = parsed.SMTP_HOST.trim(); process.env.SMTP_HOST = env.SMTP_HOST; }
      if (parsed.SMTP_PORT !== undefined) { env.SMTP_PORT = parsed.SMTP_PORT.trim(); process.env.SMTP_PORT = env.SMTP_PORT; }
      if (parsed.SMTP_USER !== undefined) { env.SMTP_USER = parsed.SMTP_USER.trim(); env.GMAIL_USER = env.SMTP_USER; process.env.SMTP_USER = env.SMTP_USER; process.env.GMAIL_USER = env.SMTP_USER; }
      if (parsed.SMTP_PASS !== undefined) { env.SMTP_PASS = parsed.SMTP_PASS.trim(); env.GMAIL_PASS = env.SMTP_PASS; process.env.SMTP_PASS = env.SMTP_PASS; process.env.GMAIL_PASS = env.SMTP_PASS; }
      if (parsed.GMAIL_USER !== undefined) { env.GMAIL_USER = parsed.GMAIL_USER.trim(); env.SMTP_USER = env.GMAIL_USER; process.env.GMAIL_USER = env.GMAIL_USER; process.env.SMTP_USER = env.GMAIL_USER; }
      if (parsed.GMAIL_PASS !== undefined) { env.GMAIL_PASS = parsed.GMAIL_PASS.trim(); env.SMTP_PASS = env.GMAIL_PASS; process.env.GMAIL_PASS = env.GMAIL_PASS; process.env.SMTP_PASS = env.GMAIL_PASS; }
      if (parsed.MAIL_FROM !== undefined) { env.MAIL_FROM = parsed.MAIL_FROM.trim(); process.env.MAIL_FROM = env.MAIL_FROM; }
      if (parsed.ALERT_EMAIL !== undefined) { env.ALERT_EMAIL = parsed.ALERT_EMAIL.trim(); process.env.ALERT_EMAIL = env.ALERT_EMAIL; }
      if (parsed.SERPER_API_KEY !== undefined) {
        env.SERPER_API_KEY = parsed.SERPER_API_KEY.trim();
        env.SEARCHAPI_KEY = env.SERPER_API_KEY;
        process.env.SERPER_API_KEY = env.SERPER_API_KEY;
        process.env.SEARCHAPI_KEY = env.SERPER_API_KEY;
      } else if (parsed.SEARCHAPI_KEY !== undefined) {
        env.SEARCHAPI_KEY = parsed.SEARCHAPI_KEY.trim();
        env.SERPER_API_KEY = env.SEARCHAPI_KEY;
        process.env.SEARCHAPI_KEY = env.SEARCHAPI_KEY;
        process.env.SERPER_API_KEY = env.SEARCHAPI_KEY;
      }
      if (parsed.MONGODB_URI !== undefined) { env.MONGODB_URI = parsed.MONGODB_URI.trim(); process.env.MONGODB_URI = env.MONGODB_URI; }
      if (parsed.MONGODB_DB !== undefined) { env.MONGODB_DB = parsed.MONGODB_DB.trim(); process.env.MONGODB_DB = env.MONGODB_DB; }
      if (parsed.DATABASE_URL !== undefined) { env.DATABASE_URL = parsed.DATABASE_URL.trim(); process.env.DATABASE_URL = env.DATABASE_URL; }
    }
  } catch {}

  // 2. Read persistent settings from the database (takes priority over .env in production)
  try {
    const dbSettings = await prisma.systemSetting.findMany();
    for (const item of dbSettings) {
      if (item.key && typeof item.value === "string" && item.value.trim() !== "") {
        (env as any)[item.key] = item.value.trim();
        process.env[item.key] = item.value.trim();
      }
    }
  } catch {}
}

export async function getSettings() {
  await refreshEnvFromDisk();
  const serperKey = env.SERPER_API_KEY || env.SEARCHAPI_KEY;
  const smtpUser = env.SMTP_USER || env.GMAIL_USER;
  const smtpPass = env.SMTP_PASS || env.GMAIL_PASS;
  return {
    apifyApiUrl: env.APIFY_API_URL,
    apifyApiKey: env.APIFY_API_KEY,
    aiApiUrl: env.AI_API_URL,
    aiApiKey: env.AI_API_KEY,
    aiModel: env.AI_MODEL,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpUser: smtpUser,
    smtpPass: smtpPass,
    gmailUser: smtpUser,
    gmailPass: smtpPass,
    mailFrom: env.MAIL_FROM,
    alertEmail: env.ALERT_EMAIL,
    searchApiKey: serperKey,
    serperApiKey: serperKey,
    mongodbUri: env.MONGODB_URI,
    mongodbDb: env.MONGODB_DB,
    databaseUrl: env.DATABASE_URL,
    apifyConfigured: Boolean(env.APIFY_API_URL && env.APIFY_API_KEY),
    aiConfigured: Boolean(env.AI_API_URL && env.AI_API_KEY),
    smtpConfigured: Boolean(smtpUser && smtpPass),
    gmailConfigured: Boolean(smtpUser && smtpPass),
    searchApiConfigured: Boolean(serperKey),
    serperApiConfigured: Boolean(serperKey),
    databaseConfigured: Boolean(env.DATABASE_URL),
  };
}

export interface SettingsUpdatePayload {
  apifyApiUrl?: string;
  apifyApiKey?: string;
  aiApiUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPass?: string;
  gmailUser?: string;
  gmailPass?: string;
  mailFrom?: string;
  alertEmail?: string;
  searchApiKey?: string;
  serperApiKey?: string;
  mongodbUri?: string;
  mongodbDb?: string;
  databaseUrl?: string;
}

export async function updateSettings(updates: SettingsUpdatePayload) {
  if (updates.apifyApiUrl !== undefined) {
    env.APIFY_API_URL = updates.apifyApiUrl.trim();
    process.env.APIFY_API_URL = env.APIFY_API_URL;
  }
  if (updates.apifyApiKey !== undefined) {
    env.APIFY_API_KEY = updates.apifyApiKey.trim();
    process.env.APIFY_API_KEY = env.APIFY_API_KEY;
  }
  if (updates.aiApiUrl !== undefined) {
    env.AI_API_URL = updates.aiApiUrl.trim();
    process.env.AI_API_URL = env.AI_API_URL;
  }
  if (updates.aiApiKey !== undefined) {
    env.AI_API_KEY = updates.aiApiKey.trim();
    process.env.AI_API_KEY = env.AI_API_KEY;
  }
  if (updates.aiModel !== undefined) {
    env.AI_MODEL = updates.aiModel.trim();
    process.env.AI_MODEL = env.AI_MODEL;
  }
  if (updates.smtpHost !== undefined) {
    env.SMTP_HOST = updates.smtpHost.trim();
    process.env.SMTP_HOST = env.SMTP_HOST;
  }
  if (updates.smtpPort !== undefined) {
    env.SMTP_PORT = updates.smtpPort.trim();
    process.env.SMTP_PORT = env.SMTP_PORT;
  }
  const newSmtpUser = updates.smtpUser !== undefined ? updates.smtpUser.trim() : (updates.gmailUser !== undefined ? updates.gmailUser.trim() : undefined);
  if (newSmtpUser !== undefined) {
    env.SMTP_USER = newSmtpUser;
    env.GMAIL_USER = newSmtpUser;
    process.env.SMTP_USER = newSmtpUser;
    process.env.GMAIL_USER = newSmtpUser;
  }
  const newSmtpPass = updates.smtpPass !== undefined ? updates.smtpPass.trim() : (updates.gmailPass !== undefined ? updates.gmailPass.trim() : undefined);
  if (newSmtpPass !== undefined) {
    env.SMTP_PASS = newSmtpPass;
    env.GMAIL_PASS = newSmtpPass;
    process.env.SMTP_PASS = newSmtpPass;
    process.env.GMAIL_PASS = newSmtpPass;
  }
  if (updates.mailFrom !== undefined) {
    env.MAIL_FROM = updates.mailFrom.trim();
    process.env.MAIL_FROM = env.MAIL_FROM;
  }
  if (updates.alertEmail !== undefined) {
    env.ALERT_EMAIL = updates.alertEmail.trim();
    process.env.ALERT_EMAIL = env.ALERT_EMAIL;
  }
  const newSerperKey = updates.serperApiKey !== undefined ? updates.serperApiKey.trim() : (updates.searchApiKey !== undefined ? updates.searchApiKey.trim() : undefined);
  if (newSerperKey !== undefined) {
    env.SERPER_API_KEY = newSerperKey;
    env.SEARCHAPI_KEY = newSerperKey;
    process.env.SERPER_API_KEY = newSerperKey;
    process.env.SEARCHAPI_KEY = newSerperKey;
  }
  if (updates.mongodbUri !== undefined) {
    env.MONGODB_URI = updates.mongodbUri.trim();
    process.env.MONGODB_URI = env.MONGODB_URI;
  }
  if (updates.mongodbDb !== undefined) {
    env.MONGODB_DB = updates.mongodbDb.trim();
    process.env.MONGODB_DB = env.MONGODB_DB;
  }
  if (updates.databaseUrl !== undefined) {
    env.DATABASE_URL = updates.databaseUrl.trim();
    process.env.DATABASE_URL = env.DATABASE_URL;
  }

  // Persist resolved settings in the database so they survive redeploys
  try {
    const finalMap: Record<string, string> = {
      APIFY_API_URL: env.APIFY_API_URL,
      APIFY_API_KEY: env.APIFY_API_KEY,
      AI_API_URL: env.AI_API_URL,
      AI_API_KEY: env.AI_API_KEY,
      AI_MODEL: env.AI_MODEL,
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT,
      SMTP_USER: env.SMTP_USER,
      SMTP_PASS: env.SMTP_PASS,
      GMAIL_USER: env.GMAIL_USER,
      GMAIL_PASS: env.GMAIL_PASS,
      MAIL_FROM: env.MAIL_FROM,
      ALERT_EMAIL: env.ALERT_EMAIL,
      SERPER_API_KEY: env.SERPER_API_KEY,
      SEARCHAPI_KEY: env.SEARCHAPI_KEY,
      MONGODB_URI: env.MONGODB_URI,
      MONGODB_DB: env.MONGODB_DB,
      DATABASE_URL: env.DATABASE_URL,
    };

    for (const [envKey, val] of Object.entries(finalMap)) {
      if (val !== undefined && val !== null) {
        await prisma.systemSetting.upsert({
          where: { key: envKey },
          update: { value: val.trim() },
          create: { key: envKey, value: val.trim() },
        });
      }
    }
  } catch (err) {
    console.warn("Could not save settings to database:", err);
  }

  persistToEnvFile({
    APIFY_API_URL: env.APIFY_API_URL,
    APIFY_API_KEY: env.APIFY_API_KEY,
    AI_API_URL: env.AI_API_URL,
    AI_API_KEY: env.AI_API_KEY,
    AI_MODEL: env.AI_MODEL,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    GMAIL_USER: env.GMAIL_USER,
    GMAIL_PASS: env.GMAIL_PASS,
    MAIL_FROM: env.MAIL_FROM,
    ALERT_EMAIL: env.ALERT_EMAIL,
    SERPER_API_KEY: env.SERPER_API_KEY,
    SEARCHAPI_KEY: env.SEARCHAPI_KEY,
    MONGODB_URI: env.MONGODB_URI,
    MONGODB_DB: env.MONGODB_DB,
    DATABASE_URL: env.DATABASE_URL,
  });

  return await getSettings();
}

function persistToEnvFile(map: Record<string, string>) {
  try {
    let content = "";
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, "utf-8");
    }

    const lines = content.split(/\r?\n/);
    const updatedKeys = new Set<string>();

    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return line;

      const key = line.slice(0, eqIndex).trim();
      if (key in map) {
        updatedKeys.add(key);
        return `${key}=${map[key]}`;
      }
      return line;
    });

    Object.entries(map).forEach(([key, val]) => {
      if (!updatedKeys.has(key)) {
        newLines.push(`${key}=${val}`);
      }
    });

    fs.writeFileSync(envPath, newLines.join("\n"), "utf-8");
  } catch (err) {
    console.error("Failed to update .env file:", err);
  }
}

export function assertApifyConfigured() {
  if (!env.APIFY_API_URL || !env.APIFY_API_KEY) {
    throw new ConfigError(
      "Apify is not configured. Set APIFY_API_URL and APIFY_API_KEY in dashboard settings or backend/.env."
    );
  }
}

export function assertAiConfigured() {
  if (!env.AI_API_KEY) {
    throw new ConfigError(
      "Mistral AI is not configured. Set MISTRAL_API_KEY / AI_API_KEY in dashboard settings or backend/.env."
    );
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
