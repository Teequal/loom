import { NextResponse, type NextRequest } from "next/server";
import { fromOutside, INVITE_COOKIE, invitesOn, testerByCode } from "@/server/access";
import { invitePage } from "@/server/invite-page";

// Invite-only from outside: a page needs a working invite cookie (the join link sets it). The API
// checks the same, and more (whose campaign it is), in its own routes.
export async function proxy(request: NextRequest) {
  if (!invitesOn() || !fromOutside(request)) return NextResponse.next();
  const code = request.cookies.get(INVITE_COOKIE)?.value;
  if (code && (await testerByCode(code))) return NextResponse.next();
  return invitePage("Loom is invite-only for now. Open the invite link you were sent.");
}

// Pages only: the join link, the API (it answers for itself) and static files pass straight through.
export const config = {
  matcher: ["/((?!join/|api/|_next/|favicon|.*\\.(?:svg|png|jpg|ico|webp|woff2?)$).*)"],
};
