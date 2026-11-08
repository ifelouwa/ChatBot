import { createHash } from "node:crypto";
import { db } from "./db";

function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const limits = {
  perIp: () => limitFromEnv("RATE_LIMIT_PER_IP_PER_10_MIN", 20),
  turnsPerConversation: () => limitFromEnv("MAX_TURNS_PER_CONVERSATION", 40),
  aiTurnsPerDay: () => limitFromEnv("MAX_AI_TURNS_PER_DAY", 500),
};

/** Counts one hit in the current window and says whether it's within the limit. */
async function hit(key: string, windowSeconds: number, limit: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const { rows } = await db().query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  return rows[0]!.count <= limit;
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Only a salted hash is stored, so the table holds no visitor IP addresses. */
export function allowRequestFromIp(request: Request): Promise<boolean> {
  const hash = createHash("sha256")
    .update(`${process.env.IP_HASH_SALT ?? ""}:${clientIp(request)}`)
    .digest("hex");
  return hit(`ip:${hash}`, 600, limits.perIp());
}

/** The site-wide ceiling on Claude calls, which caps the daily bill. */
export function allowAiTurnToday(): Promise<boolean> {
  return hit("ai-turns", 86_400, limits.aiTurnsPerDay());
}

export async function deleteExpiredRateLimits(): Promise<void> {
  await db().query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
}

/** Blocks other websites from driving this API from a visitor's browser. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
