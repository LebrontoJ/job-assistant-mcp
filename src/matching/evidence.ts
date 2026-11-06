import { digest, requirementsOf, SourceSchema, type EvidenceBundle, type Source } from './types.js';
import type { ParsedJd } from '../server/jd.js';
export type SearchHit = Pick<Source, 'id' | 'source' | 'heading' | 'text'>;
export type EvidenceSearch = (query: string, k: number) => Promise<SearchHit[]>;
export interface EvidenceLimits { maxRequirements?: number; maxSources?: number; maxChars?: number; k?: number }
/** Never truncate a passage: omitted context is explicitly recorded instead. */
export function addSources(bundle: EvidenceBundle, requirementId: string, hits: SearchHit[], limits: EvidenceLimits = {}): number {
  const packet = bundle.packets.find(p => p.requirement.id === requirementId);
  if (!packet) throw new Error('Unknown requirement');
  let chars = bundle.sources.reduce((n, s) => n + s.text.length + s.heading.length + s.source.length, 0);
  let added = 0;
  for (const hit of hits) {
    if (!hit.text.trim()) continue;
    const source = SourceSchema.parse({ ...hit, hash: digest(hit) });
    const existing = bundle.sources.find(s => s.id === source.id);
    if (existing && existing.hash !== source.hash) throw new Error('Source changed during matching');
    const size = source.text.length + source.heading.length + source.source.length;
    if (!existing && (bundle.sources.length >= (limits.maxSources ?? 60) || chars + size > (limits.maxChars ?? 50_000))) {
      packet.retrievalStatus = 'context_limited'; continue;
    }
    if (!existing) { bundle.sources.push(source); chars += size; added++; }
    if (!packet.sourceIds.includes(source.id)) packet.sourceIds.push(source.id);
  }
  if (packet.retrievalStatus !== 'context_limited') packet.retrievalStatus = packet.sourceIds.length ? 'complete' : 'no_hits';
  return added;
}
export async function collectEvidence(jd: Pick<ParsedJd, 'requirements' | 'niceToHave'>, search: EvidenceSearch, limits: EvidenceLimits = {}, corpusHash?: string): Promise<EvidenceBundle> {
  const requirements = requirementsOf(jd);
  const bundle: EvidenceBundle = { packets: requirements.map(requirement => ({ requirement, sourceIds: [], retrievalStatus: 'context_limited' })), sources: [], snapshotHash: '' };
  for (const packet of bundle.packets.slice(0, limits.maxRequirements ?? 40)) {
    packet.retrievalStatus = 'no_hits';
    addSources(bundle, packet.requirement.id, await search(packet.requirement.originalText, limits.k ?? 5), limits);
  }
  bundle.snapshotHash = digest({ corpusHash, requirements, sources: bundle.sources.map(s => s.hash) });
  return bundle;
}
