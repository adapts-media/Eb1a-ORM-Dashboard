import { PrismaClient } from "@prisma/client";

function databaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw || raw.startsWith("file:")) {
    // Fail loudly. A hardcoded fallback here meant a missing or misconfigured
    // DATABASE_URL silently connected to a different database entirely.
    throw new Error(
      "DATABASE_URL is not set to a PostgreSQL connection string. Configure it in backend/.env."
    );
  }
  return raw;
}

// Single shared Prisma client instance for the whole process.
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl() } },
});

/**
 * Executes a database query with a single automatic retry for transient
 * connection drops (P1001).
 */
export async function withDbRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isTransientConnError = err?.code === "P1001" || err?.message?.includes("Can't reach database server");
      if (isTransientConnError && attempt <= maxRetries) {
        console.warn(`⚠️ [Prisma DB] Transient connection error (P1001). Retrying attempt ${attempt}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
}
