// Typed acts: what the players do to someone, as one of a small set of verbs. An act has who does
// it (a PC, or the party), who it's done to (an NPC or a faction), and how it landed. Code reads
// acts from three places, never from the model's prose:
// - the moment the GM typed ("Kira helps Ysolde with the crates"), by the reading rules below;
// - a choice the engine offered, whose two sides each say their aim ("pay her price" = give);
// - a roll's skill aimed at someone (Persuasion on Ysolde = persuade).
// Table nudges read them (nudges.ts), and anything else that needs to know what was done to whom
// can: behaviour bounds, the change log, callbacks.

export const ACTS = ["help", "protect", "free", "heal", "give", "spare", "persuade", "deceive", "threaten", "press", "steal", "harm"] as const;
export type ActKind = (typeof ACTS)[number];

export interface Act {
  act: ActKind;
  by: string; // a PC's name, or "party"
  on: string; // an NPC's or faction's name
  landed: "done" | "failed" | "pending"; // pending: a roll still decides it
  from: "moment" | "choice" | "roll";
}

export const ACT_MEANS: Record<ActKind, string> = {
  help: "helps them with something they want or need",
  protect: "shields them from harm",
  free: "frees them (from a cell, a curse, a hold)",
  heal: "heals or tends them",
  give: "gives or pays them something",
  spare: "spares them when they could have finished them",
  persuade: "talks them round honestly",
  deceive: "lies to them or tricks them",
  threaten: "threatens or intimidates them",
  press: "pushes them on what they know",
  steal: "takes something of theirs",
  harm: "attacks or hurts them",
};

// The words for each act, as they come before the name of whoever it's done to (in the same
// clause). "from" for theft comes after the thing taken: "steals the ledger from Mora".
export const ACT_WORDS: [ActKind, RegExp][] = [
  ["spare", /\b(?:spares?|sparing|lets? (?:\w+ )?(?:live|go)|shows? mercy to|lets? off)\b[^.;!?,]{0,12}$/i],
  ["free", /\b(?:frees?|freeing|unchains?|unties?|releases?|breaks? (?:\w+ )?out|rescues?|rescuing)\b[^.;!?,]{0,12}$/i],
  ["heal", /\b(?:heals?|healing|tends? (?:to )?|bandages?|patches? up|stabili[sz]es?|cures?)\b[^.;!?,]{0,12}$/i],
  ["protect", /\b(?:protects?|protecting|shields?|shielding|defends?|defending|guards?|covers? for|stands? up for|steps? in front of)\b[^.;!?,]{0,12}$/i],
  ["help", /\b(?:helps?|helping|aids?|aiding|assists?|assisting|lends? a hand to|does (?:a )?favou?r for)\b[^.;!?,]{0,12}$/i],
  ["give", /\b(?:gives?|giving|hands?|offers?|pays?|paying|tips?|bribes?|gifts?)\b(?:[^.;!?]{0,30}?\bto)?\s+(?:the\s+)?$/i],
  ["persuade", /\b(?:persuades?|convinces?|talks? (?:\w+ )?round|pleads? with|reasons? with|appeals? to|negotiates? with|haggles? with|bargains? with|talks? \w+ down)\b[^.;!?,]{0,12}$/i],
  ["deceive", /\b(?:lies? to|lying to|tricks?|tricking|deceives?|fools?|cons?|bluffs?|cheats?|swindles?)\b[^.;!?,]{0,12}$/i],
  ["threaten", /\b(?:threatens?|threatening|intimidates?|intimidating|menaces?|bullies?|scares?|cows?|draws? (?:a |her |his |their )?(?:blade|knife|sword|weapon) on)\b[^.;!?,]{0,12}$/i],
  ["press", /\b(?:interrogates?|interrogating|questions?|questioning|presses?|pressing|grills?|asks? (?:\w+ )?about|demands? (?:answers|the truth) from|confronts?)\b[^.;!?,]{0,12}$/i],
  ["steal", /\b(?:steals?|stealing|pickpockets?|robs?|robbing|swipes?|pinches?|lifts?|snatches?|takes?)\b[^.;!?]{0,30}?\bfrom\s+(?:the\s+)?$|\b(?:robs?|robbing|pickpockets?|mugs?)\s+(?:the\s+)?$/i],
  ["harm", /\b(?:attacks?|attacking|stabs?|stabbing|shoots?|punches?|hits?|strikes?|kills?|kicks?|ambush(?:es)?|fights?|fighting|charges? at|casts? \w+ (?:at|on))\b[^.;!?,]{0,12}$/i],
];

// What a skill aimed at someone means as an act.
export const SKILL_ACT: Record<string, ActKind> = { Persuasion: "persuade", Deception: "deceive", Intimidation: "threaten", "Sleight of Hand": "steal" };
