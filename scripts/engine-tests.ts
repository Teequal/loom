// Engine tests that need no database or model: the moment-reading rules' own examples.
// Run: npm run test:engine
import { checkReadingRules, type ReadEntity } from "../src/core/moment-reading";

let id = 0;
const e = (name: string, type: string, aliases: string[] = []): ReadEntity => ({ id: ++id, name, type, aliases });
const cast = [
  e("Bhen", "npc"),
  e("Professor Aldric Vex", "npc", ["Vex"]),
  e("Zara the Unbound", "npc"),
  e("Mother Ysolde", "npc", ["Ysolde"]),
  e("Salaena", "pc"),
  e("Darius", "pc"),
  e("Khayiulad", "pc"),
  e("Iresia", "pc"),
  e("Resistance Headquarters", "location", ["Resistance HQ"]),
  e("Monk figurine", "item", ["monk figurine"]),
  e("Knight figurine", "item", ["knight figurine"]),
];

const results = checkReadingRules(cast);
for (const r of results) if (!r.ok) console.log(`FAIL ${r.rule}: "${r.moment}" → ${r.got}`);
const ok = results.filter((r) => r.ok).length;
console.log(`moment reading: ${ok}/${results.length}`);
process.exit(ok === results.length ? 0 : 1);
