import { timingSafeEqual } from "node:crypto";
import { deliverDueNotifications } from "@/lib/notify";
import { deleteExpiredRateLimits } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Retries failed alerts even when the site has no traffic. */
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  await deliverDueNotifications();
  await deleteExpiredRateLimits();
  return Response.json({ ok: true });
}
