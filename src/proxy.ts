import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function passwordMatches(header: string | null, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(sha256(given), sha256(password));
}

/** Locks /admin behind a password, and stays locked if none is configured. */
export function proxy(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (password && passwordMatches(request.headers.get("authorization"), password)) {
    return NextResponse.next();
  }
  return new NextResponse(password ? "Password required" : "Set ADMIN_PASSWORD to open the inbox", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Lead inbox", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
