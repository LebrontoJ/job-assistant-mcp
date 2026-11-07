import { AnthropicClient, type AnthropicLike } from '../../src/agent/llm/anthropic.js';
import { GeminiJdExtractor, type ExtractionApi } from '../../src/parsing/gemini.js';
import type { Fault } from './types.js';
/** SDK-boundary fixtures use public request contents only. They never receive a case or gold labels. */
export function scriptedProviders(fault: Fault = 'none', observe?: (stage: string, payload: string) => void) {
  let matchCalls = 0;
  let signalReady!: () => void, signalAborted!: () => void;
  const ready = new Promise<void>(r => signalReady = r), aborted = new Promise<void>(r => signalAborted = r);
  const parse = (jd: string) => {
    const lines = jd.split('\n').map(s => s.trim()).filter(Boolean);
    const data = { title: lines[0]!.replace(/^Job title:\s*/i,''), company: jd.match(/(?:Company:|公司：)\s*([^\n]+)/)?.[1] ?? null,
      location: null, workMode: null, minYearsExperience: null, responsibilities: [] as string[], requirements: [] as string[], niceToHave: [] as string[], skills: [] as string[] };
    let kind: 'requirements' | 'niceToHave' | undefined;
    for (const line of lines.slice(1)) {
      if (/^(?:Requirements|Qualifications|Minimum requirements|What you will need|岗位要求)[:：]$/i.test(line)) kind = 'requirements';
      else if (/^(?:Preferred|Bonus|Nice to have|Preferred qualifications|加分项)[:：]$/i.test(line)) kind = 'niceToHave';
      else if (kind && /^(?:[-*•]|\d+\.)\s+/.test(line)) data[kind].push(line.replace(/^(?:[-*•]|\d+\.)\s+/,''));
    }
    const prose = jd.match(/Mandatory capabilities: (.*?)(?:\. Preferred capability:|\.$)/);
    if (prose) data.requirements = prose[1]!.split(' / ');
    const preferred = jd.match(/Preferred capability: (.*?)\.$/); if (preferred) data.niceToHave = [preferred[1]!];
    return { data, workModeEvidence: null, yearsEvidence: null };
  };
  const parserApi: ExtractionApi = { models: { generateContent: async req => {
    observe?.('parser', JSON.stringify(req));
    if (fault === 'parser_timeout') return new Promise((_, reject) => req.config?.abortSignal?.addEventListener('abort', () => reject(req.config?.abortSignal?.reason), { once: true }));
    const jd = ((req.contents as any[])[0]?.parts?.[0]?.text ?? '') as string;
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(parse(jd)) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } as any;
  } } };
  const words = (s: string) => (s.toLowerCase().match(/[a-z]+|[\u4e00-\u9fff]+/g) ?? []).filter(w => !['experience','with','have','a','the','of','and'].includes(w));
  const create = async (params: Record<string,unknown>, options?: { signal?: AbortSignal }) => {
    const system = String(params.system), messages = params.messages as Array<{ content: string }>;
    const stage = system.includes('assess each job requirement') ? 'matching' : system.includes('find missing candidate evidence') ? 'planner' : system.includes('verify factual entailment') ? 'verifier' : 'draft';
    observe?.(stage, JSON.stringify(params));
    if (stage === 'matching' && fault === 'user_cancel') {
      signalReady();
      return new Promise<never>((_,reject) => { const abort = () => { signalAborted(); reject(options?.signal?.reason); }; options?.signal?.addEventListener('abort',abort,{once:true}); if (options?.signal?.aborted) abort(); });
    }
    if (stage === 'matching' && fault === 'match_failure' && ++matchCalls >= 2) throw new Error('fixture provider failure');
    if (stage === 'draft' && fault === 'draft_failure') throw new Error('fixture draft failure');
    const input = JSON.parse(messages[0]!.content);
    let value: unknown;
    if (stage === 'matching') value = { items: input.requirements.map((r: any) => ({ requirementId: r.id, criteria: r.criteria.map((c: any) => {
      const allowed = input.packets.find((p: any) => p.requirement.id === r.id)?.sourceIds ?? [];
      const terms = words(c.text);
      const sources = input.sources.filter((s: any) => allowed.includes(s.id)).map((s: any) => ({ ...s, score: terms.filter(w => s.text.toLowerCase().includes(w)).length / Math.max(1,terms.length) })).sort((a: any,b: any) => b.score-a.score);
      const source = sources[0];
      let verdict = !source || source.score < 0.5 ? 'insufficient' : /never|从未/i.test(source.text) ? 'contradicted' : /plan|proposal|尚未|计划/i.test(source.text) ? 'insufficient' : /only|prototype|仅/i.test(source.text) || source.score < 1 ? 'partial' : 'supported';
      if (fault === 'search_failure' || fault === 'unapproved_write') verdict = 'insufficient';
      return { criterionId: c.id, verdict, evidence: verdict === 'insufficient' ? [] : [{ sourceId: source.id, quote: source.text }], reason: 'Scripted public-input fixture; not semantic model quality.', missingInformation: ['partial','insufficient'].includes(verdict) ? ['More independently verified evidence needed.'] : [] };
    }) })) };
    else if (stage === 'planner') {
      if (fault === 'search_failure' || fault === 'unapproved_write') return { content: [{ type: 'tool_use', id: 'fixture-search', name: fault === 'unapproved_write' ? 'add_application' : 'search_profile', input: fault === 'unapproved_write' ? { company:'Injected', role:'Injected', confirm:true } : { requirementId: input.requirements[0].id, query: 'additional candidate experience' } }], stop_reason: 'tool_use', usage: { input_tokens:1, output_tokens:1 } };
      return { content: [{type:'text',text:'No further query.'}], stop_reason:'end_turn', usage:{input_tokens:1,output_tokens:1} };
    } else if (stage === 'verifier') value = { supported: input.evidence.some((e: any) => e.text.includes(input.claim)) };
    else value = { rewrites: input.evidence.slice(0,5).map((e: any) => ({text:e.text.split('\n')[0],evidenceIds:[e.id]})), suggestions:[] };
    return { content: [{type:'text',text:JSON.stringify(value)}], stop_reason:'end_turn', usage:{input_tokens:1,output_tokens:1} };
  };
  const api = { messages:{create}, beta:{messages:{create}} } as AnthropicLike;
  return { extractor: new GeminiJdExtractor('scripted-sdk', 'synthetic-test-key', parserApi), llm: new AnthropicClient('scripted-sdk', {client:api}), ready, aborted };
}
