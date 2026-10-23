// Embedding providers behind one small interface, like the LLM: swap models without touching
// retrieval. Vectors from different models can't be compared, so every stored vector records the
// model that made it.

export interface EmbeddingProvider {
  model: string; // stored with every vector
  dims: number;
  // "query" for the moment being searched with, "document" for what's being searched.
  embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]>;
}

// Local: BAAI's bge-small (384 dims) through Transformers.js. Free, private, offline after a
// one-off ~35 MB download into data/models.
let localPipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;
export const localProvider: EmbeddingProvider = {
  model: "local:bge-small-en-v1.5",
  dims: 384,
  async embed(texts, kind) {
    if (!texts.length) return [];
    localPipe ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = "./data/models";
      return (await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" })) as never;
    })();
    const pipe = await localPipe;
    // bge models expect this prefix on search queries.
    const input = kind === "query" ? texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`) : texts;
    const out = await pipe(input, { pooling: "cls", normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  },
};

// Hosted: Voyage AI (Anthropic's recommended embeddings partner). Needs VOYAGE_API_KEY.
export const voyageProvider: EmbeddingProvider = {
  model: "voyage:voyage-3.5-lite",
  dims: 1024,
  async embed(texts, kind) {
    if (!texts.length) return [];
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY isn't set (add it to .env to use hosted embeddings)");
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ input: texts.slice(i, i + 64), model: "voyage-3.5-lite", input_type: kind }),
      });
      if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      for (const d of json.data) out.push(Float32Array.from(d.embedding));
    }
    return out;
  },
};

// Which provider to use: LOOM_EMBEDDINGS=local (default) | voyage | off.
export function embeddingProvider(name = process.env.LOOM_EMBEDDINGS ?? "local"): EmbeddingProvider | null {
  if (name === "off" || name === "none") return null;
  if (name === "voyage") return voyageProvider;
  return localProvider;
}

export function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
