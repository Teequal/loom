// Engine tests that need no database or model: the moment-reading rules' own examples.
// Run: npm run test:engine
import { checkReadingRules, type ReadEntity } from "../src/core/moment-reading";
import { checkInterplayExamples } from "../src/core/world/test-graph";

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
// The interplay table's examples, in a small world built in memory.
const inter = checkInterplayExamples();
for (const r of inter) if (!r.ok) console.log(`FAIL interplay ${r.id}: ${r.says} → ${r.got}`);
const interOk = inter.filter((r) => r.ok).length;
console.log(`interplays: ${interOk}/${inter.length}`);
for (const r of results) if (!r.ok) console.log(`FAIL ${r.rule}: "${r.moment}" → ${r.got}`);
const ok = results.filter((r) => r.ok).length;
console.log(`moment reading: ${ok}/${results.length}`);
process.exit(ok === results.length && interOk === inter.length ? 0 : 1);
