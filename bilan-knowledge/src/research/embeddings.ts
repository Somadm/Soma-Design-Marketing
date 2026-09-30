import type { Config } from "../config.js";
import type { DbClient } from "../db/pool.js";
import { VOYAGE_USD_PER_MTOK, type Budget } from "./budget.js";

export interface Embedder {
  embed(texts: string[], inputType: "document" | "query", budget: Budget | null): Promise<number[][]>;
}

let vectorColumn: boolean | null = null;

/** True when pgvector is installed and entry_versions.embedding exists. */
export async function hasVectorColumn(db: DbClient): Promise<boolean> {
  if (vectorColumn === null) {
    const { rowCount } = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'entry_versions' AND column_name = 'embedding'",
    );
    vectorColumn = Boolean(rowCount);
  }
  return vectorColumn;
}

export function resetVectorColumnCache() {
  vectorColumn = null;
}

/** Voyage embeddings (optional). Without VOYAGE_API_KEY, search is full-text only. */
export class VoyageEmbedder implements Embedder {
  constructor(
    private cfg: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[], inputType: "document" | "query", budget: Budget | null): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.fetchImpl("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${this.cfg.VOYAGE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ input: texts, model: this.cfg.EMBEDDING_MODEL, input_type: inputType, output_dimension: 1024 }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens: number }; detail?: string };
    if (!res.ok || !json.data) throw new Error(`Voyage embeddings failed: ${json.detail ?? `HTTP ${res.status}`}`);
    const tokens = json.usage?.total_tokens ?? 0;
    await budget?.recordOther("voyage", `embed_${inputType}`, tokens, (tokens * VOYAGE_USD_PER_MTOK) / 1_000_000);
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}
