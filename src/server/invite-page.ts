// The one page someone sees without an invite (or with a link that no longer works): plain HTML,
// in Loom's colours, light and dark.
export function invitePage(message: string, status = 401) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Loom</title>
<style>
:root{--bg:#f6f3ee;--fg:#1d1b18;--muted:#6f685e;--thread:#b0662f}
@media (prefers-color-scheme:dark){:root{--bg:#16140f;--fg:#ece7de;--muted:#9c9488;--thread:#d9894d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:16px}
main{max-width:26rem}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-0.01em}h1 span{color:var(--thread)}
p{margin:0;color:var(--muted)}
</style></head><body><main><h1>Loom<span>.</span></h1><p>${message}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
