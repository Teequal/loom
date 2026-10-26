import { dbReady } from "@/server/db";
import { fromOutside, INVITE_COOKIE, testerByCode } from "@/server/access";
import { invitePage } from "@/server/invite-page";

// An invite link: remembers the code in this browser (60 days), then opens Loom.
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  await dbReady();
  if (!(await testerByCode(code))) return invitePage("That invite link doesn't work any more. Ask whoever sent it for a new one.", 404);
  const secure = fromOutside(request) ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": `${INVITE_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${60 * 24 * 3600}; HttpOnly; SameSite=Lax${secure}`, "Cache-Control": "no-store" },
  });
}
