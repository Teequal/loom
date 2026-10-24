// Player agency in plans. Improv options are scaffolded so a PC can't act; plans (Develop, fights,
// fresh ideas) are prose, so this reads the prose: a sentence where the party, or a PC by name,
// does something is the GM deciding for the players ("The party drags Darius into the cellar").
// Conditions and possibilities are fine: "If the party hides in the cellar…", "they can follow it".

const CONDITIONAL = /^\s*(?:if|when|whenever|should|unless|once|whether|in case|as soon as|before|after|while|until|wherever|whoever)\b/i;
// What a subject may be followed by without deciding anything for the player.
const ALLOWED_NEXT = new Set(
  (
    "can could may might would will must should need needs needed has have had is are was were be been gets get to " +
    "faces face finds find learns learn discovers discover hears hear sees see notices notice feels feel realises realizes " +
    "and or but who whose whom which that with without of in on at for from by as than into through between among against " +
    "still also already now then itself themselves himself herself"
  ).split(" "),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function planSlips(text: string, pcs: { name: string; aliases?: string[] }[]): string[] {
  const names = pcs.flatMap((p) => [p.name, p.name.split(/\s+/)[0], ...(p.aliases ?? [])]).filter((n) => n && n.length >= 3 && /^[A-Z]/.test(n));
  const subject = `(?:the party|the group|the heroes|the adventurers|the players|everyone in the party|${names.map(escape).join("|") || "(?!)"})`;
  // The subject at the start of a sentence or clause ("…, and the party slips away").
  const at = new RegExp(`(?:^|[;:]\\s+|,\\s+(?:and|then|so)\\s+|\\band then\\s+|—\\s*)${subject}(?:\\s+and\\s+${subject})?\\s+(?:[a-z]+ly\\s+)?([a-z][a-z'’-]*)`, "gi");
  const slips: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (CONDITIONAL.test(sentence)) continue;
    for (const m of sentence.matchAll(at)) {
      const next = m[1].toLowerCase();
      if (/^['’]s$/.test(next) || ALLOWED_NEXT.has(next)) continue;
      // "Darius's wound…": the possessive is caught here as the next "word".
      if (/^['’]/.test(next)) continue;
      slips.push(sentence.trim());
      break;
    }
  }
  return slips;
}

// Drops the sentences that decide for the players, keeping the rest of the text.
export function withoutSlips(text: string, pcs: { name: string; aliases?: string[] }[]) {
  const bad = new Set(planSlips(text, pcs));
  if (!bad.size) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !bad.has(s.trim()))
    .join(" ")
    .trim();
}
