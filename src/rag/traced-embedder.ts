import type { Embedder, EmbedKind } from './embedder.js';
import { traceStage, type Tracer } from '../agent/trace.js';
import { ExecutionBudget } from '../agent/execution.js';
/** No input text or vectors are recorded. Index/query embedding failures remain distinguishable. */
export function tracedEmbedder(inner: Embedder | undefined, tracer: Tracer | undefined, runId: string): Embedder | undefined {
  if (!inner) return undefined;
  return { id: inner.id, embed: (texts: string[], kind?: EmbedKind) => traceStage(tracer, runId, `embedding.${kind ?? 'document'}`, () => new ExecutionBudget(60_000).run('embedding', 60_000, () => inner.embed(texts, kind))) };
}
