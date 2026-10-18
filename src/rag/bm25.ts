import { tokenize } from "./tokenize.js";

export interface Scored {
  index: number;
  score: number;
}

export class Bm25 {
  private readonly docs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(
    texts: string[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    this.docs = texts.map((t) => {
      const tf = new Map<string, number>();
      for (const tok of tokenize(t)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.docs.map((tf) => [...tf.values()].reduce((a, c) => a + c, 0));
    for (const tf of this.docs) for (const tok of tf.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
    this.avgLen = this.lengths.length ? this.lengths.reduce((a, c) => a + c, 0) / this.lengths.length : 0;
  }

  /** Distinct tokens of document `i`, for coverage checks. */
  tokensOf(i: number): ReadonlySet<string> {
    return new Set(this.docs[i]?.keys() ?? []);
  }

  /** Documents with a positive score, best first. */
  search(query: string): Scored[] {
    const n = this.docs.length;
    const terms = [...new Set(tokenize(query))];
    const out: Scored[] = [];
    this.docs.forEach((tf, index) => {
      let score = 0;
      for (const term of terms) {
        const f = tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = 1 - this.b + (this.b * (this.lengths[index] ?? 0)) / (this.avgLen || 1);
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * norm);
      }
      if (score > 0) out.push({ index, score });
    });
    return out.sort((a, b) => b.score - a.score);
  }
}
