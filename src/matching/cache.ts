import type { MatchAssessment } from './types.js';
/** Bounded process-local cache: private evidence never persists to disk. */
export class MatchCache {
  private readonly entries = new Map<string, MatchAssessment>();
  constructor(private readonly maxEntries = 64) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Match cache size must be positive');
  }
  get(key: string): MatchAssessment | undefined {
    const result = this.entries.get(key);
    if (!result) return undefined;
    const copy = structuredClone(result);
    copy.meta = { ...copy.meta, cacheHit: true, modelCalls: 0, inputTokens: 0, outputTokens: 0, searches: 0, rounds: 0, ms: 0 };
    return copy;
  }
  set(key: string, result: MatchAssessment): void {
    // Failed, partial-execution and context-limited reports must be retryable.
    const successfulStops = new Set(['completed', 'no_more_queries', 'no_new_evidence', 'search_limit']);
    if (result.meta.executionErrors || !successfulStops.has(result.meta.stoppedBecause) || !result.items.length || result.items.some(i => i.assessmentStatus !== 'assessed')) return;
    this.entries.set(key, structuredClone(result));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
