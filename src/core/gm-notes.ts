import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/client";
import { callLlm } from "./llm";

// What the GM knows and the players don't: "the microfractures cause the madness". Recaps only
// hold what the table saw, so these are entered by hand or come from answering Loom's questions
// after a recap. They shape suggestions and are never revealed outright.

export type GmNote = typeof schema.gmNotes.$inferSelect;

export const listNotes = (campaignId: number) => db.select().from(schema.gmNotes).where(eq(schema.gmNotes.campaignId, campaignId)).orderBy(desc(schema.gmNotes.id));

export async function addNote(campaignId: number, text: string, source: "dm" | "answer" = "dm") {
  await db.insert(schema.gmNotes).values({ campaignId, text: text.trim(), source });
}

export const removeNote = (campaignId: number, noteId: number) => db.delete(schema.gmNotes).where(and(eq(schema.gmNotes.campaignId, campaignId), eq(schema.gmNotes.id, noteId)));

/**
 * The notes worth sending with a moment: those naming someone or something in play, then general
 * ones naming nobody on record. Newest first; `all` is for prep, where every secret counts.
 */
export function relevantNotes(notes: GmNote[], inPlay: string[], known: string[], cap: number) {
  const has = (text: string, names: string[]) => names.some((n) => n.length >= 3 && text.toLowerCase().includes(n.toLowerCase()));
  const named = notes.filter((n) => has(n.text, inPlay));
  const general = notes.filter((n) => !named.includes(n) && !has(n.text, known));
  return [...named, ...general].slice(0, cap);
}

export const notesBlock = (notes: { text: string }[]) =>
  notes.length ? `\nGM NOTES (secret: let them shape what happens and drop hints, but never state them outright)\n${notes.map((n) => `- ${n.text}`).join("\n")}\n` : "";

const QUESTIONS = `You read a game master's session notes for a tabletop RPG, alongside what's on record, and ask what the notes leave unclear. Notes are summaries, so what mattered is often missing.

Ask 0 to 3 short questions, only where the answer would change how the story is tracked:
- a cause the notes hint at but don't state ("Were the ghostly butterflies a microfracture, or a feature of the Woods?");
- something set up with no outcome ("Darius drank two unknown potions: what will they do?");
- a hidden rule or roll the GM seems to be running;
- who someone in the notes really is, or what they're really after.
Never ask what the notes already answer, what's in the records or GM notes, or anything about what the players will do next. Zero questions is a good answer when the notes are clear.

question: one sentence, under 20 words, easy to answer in a few words. about: the name or thread it's about, as the notes put it.`;

export const QuestionsSchema = z.object({ questions: z.array(z.object({ question: z.string(), about: z.string() })) });
export type RecapQuestion = z.infer<typeof QuestionsSchema>["questions"][number];

/** Runs beside the recap's own extraction, so it adds no wait; a failed call just asks nothing. */
export async function recapQuestions(campaignId: number, records: string, notes: string): Promise<{ questions: RecapQuestion[]; costUsd: number }> {
  const secret = await listNotes(campaignId);
  const res = await callLlm({ feature: "questions", campaignId, system: QUESTIONS, prompt: `${records}\n${notesBlock(secret.slice(0, 30))}\nSESSION NOTES\n${notes}`, schema: QuestionsSchema, maxTokens: 800 });
  return { questions: res.data.questions.slice(0, 3), costUsd: res.costUsd };
}

/** An answer becomes a GM note, in a form that reads without the question beside it. */
export const answerNote = (q: string, a: string) => `${q.trim()} ${a.trim()}`;
