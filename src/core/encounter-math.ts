// 5e encounter maths, done in code so the difficulty is exact rather than the model's guess. Pure
// (no database), so the page can recompute as the GM changes counts.

export type Edition = "2014" | "2024";

// XP thresholds per character, by level (index 0 = level 1).
const T2014: [number, number, number, number][] = [
  [25, 50, 75, 100], [50, 100, 150, 200], [75, 150, 225, 400], [125, 250, 375, 500], [250, 500, 750, 1100],
  [300, 600, 900, 1400], [350, 750, 1100, 1700], [450, 900, 1400, 2100], [550, 1100, 1600, 2400], [600, 1200, 1900, 2800],
  [800, 1600, 2400, 3600], [1000, 2000, 3000, 4500], [1100, 2200, 3400, 5100], [1250, 2500, 3800, 5700], [1400, 2800, 4300, 6400],
  [1600, 3200, 4800, 7200], [2000, 3900, 5900, 8800], [2100, 4200, 6300, 9500], [2400, 4900, 7300, 10900], [2800, 5700, 8500, 12700],
];
const T2024: [number, number, number][] = [
  [50, 75, 100], [100, 150, 200], [150, 225, 400], [250, 375, 500], [500, 750, 1100],
  [600, 1000, 1400], [750, 1300, 1700], [1000, 1700, 2100], [1300, 2000, 2600], [1600, 2300, 3100],
  [1900, 2900, 4100], [2200, 3700, 4700], [2600, 4200, 5400], [2900, 4900, 6200], [3300, 5400, 7800],
  [3800, 6100, 9800], [4500, 7200, 11700], [5000, 8700, 14200], [5500, 10700, 17200], [6400, 13200, 22000],
];

export const DIFFICULTIES: Record<Edition, string[]> = {
  "2014": ["Easy", "Medium", "Hard", "Deadly"],
  "2024": ["Low", "Moderate", "High"],
};

const CR_XP: Record<string, number> = {
  "0": 10, "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900, "8": 3900,
  "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000,
  "19": 22000, "20": 25000, "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000, "28": 120000,
  "29": 135000, "30": 155000,
};
export const crXp = (cr: string) => CR_XP[cr.trim()] ?? CR_XP[String(Math.round(Number(cr)))] ?? 0;

// 2014's multiplier for how many enemies there are, shifted for unusually small or large parties.
const STEPS = [1, 1.5, 2, 2.5, 3, 4];
function multiplier(count: number, partySize: number) {
  let i = count <= 1 ? 0 : count === 2 ? 1 : count <= 6 ? 2 : count <= 10 ? 3 : count <= 14 ? 4 : 5;
  if (partySize < 3) i = Math.min(i + 1, STEPS.length - 1);
  if (partySize >= 6) i = Math.max(i - 1, 0);
  return partySize < 3 && i === STEPS.length - 1 && count > 14 ? 5 : STEPS[i];
}

export interface Foe {
  name: string;
  count: number;
  cr: string;
}

export function thresholds(levels: number[], edition: Edition) {
  const table = edition === "2024" ? T2024 : T2014;
  const sums = DIFFICULTIES[edition].map(() => 0);
  for (const raw of levels) {
    const row = table[Math.max(1, Math.min(20, Math.round(raw))) - 1];
    row.forEach((v, i) => (sums[i] += v));
  }
  return sums;
}

// The encounter's difficulty: which band its (adjusted) XP falls in, and the numbers behind it.
export function rate(foes: Foe[], levels: number[], edition: Edition) {
  const base = foes.reduce((s, f) => s + crXp(f.cr) * Math.max(0, f.count), 0);
  const count = foes.reduce((s, f) => s + Math.max(0, f.count), 0);
  const adjusted = edition === "2024" ? base : Math.round(base * multiplier(count, levels.length));
  const t = thresholds(levels, edition);
  let band = -1; // below the lowest threshold: trivial
  t.forEach((v, i) => adjusted >= v && (band = i));
  return { xp: base, adjusted, band, thresholds: t, label: band < 0 ? "Trivial" : DIFFICULTIES[edition][band] };
}

// Rescales counts so the encounter lands in the chosen band: grows or shrinks the largest group
// first, never dropping a named enemy (count 1 with a unique name stays).
export function fit(foes: Foe[], levels: number[], edition: Edition, band: number): Foe[] {
  let next = foes.map((f) => ({ ...f, count: Math.max(1, f.count) }));
  const largest = () => next.reduce((a, b, i) => (b.count > next[a].count ? i : a), 0);
  for (let guard = 0; guard < 40; guard++) {
    const r = rate(next, levels, edition);
    if (r.band === band) return next;
    const i = largest();
    if (r.band < band) next = next.map((f, j) => (j === i ? { ...f, count: f.count + 1 } : f));
    else if (next[i].count > 1) next = next.map((f, j) => (j === i ? { ...f, count: f.count - 1 } : f));
    else {
      // Every group is down to one: drop the weakest extra group, if any.
      if (next.length <= 1) return next;
      const weakest = next.reduce((a, b, j) => (crXp(b.cr) < crXp(next[a].cr) ? j : a), 0);
      next = next.filter((_, j) => j !== weakest);
    }
  }
  return next;
}
