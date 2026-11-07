import type { ParserReplay } from './comparison.js';
import { hash } from './load.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/server.js';
import { createApp } from '../../src/app/server.js';
import { ApplicationStore } from '../../src/store/applications.js';
import { ProfileIndex } from '../../src/rag/index.js';
import { JdParsingService } from '../../src/parsing/service.js';
import { createJdParser } from '../../src/parsing/factory.js';
import type { MatchingOptions } from '../../src/matching/agent.js';
import { createMatching } from '../../src/matching/factory.js';
import { createLLM } from '../../src/agent/llm/index.js';
import { MemoryTracer } from '../../src/agent/trace.js';
import { scriptedProviders } from './scripted.js';
import type { E2EProfile, Runtime, Fault } from './types.js';
export interface EnvironmentOptions { parserReplay?:ParserReplay; signal?:AbortSignal; caseTimeoutMs?:number; runtime: Runtime; matchMode: 'retrieval'|'assessment'|'agent'; fault?: Fault; env?: NodeJS.ProcessEnv; observe?: (stage:string,payload:string)=>void }
export async function createEnvironment(profile: E2EProfile, opts: EnvironmentOptions) {
  const dir = await mkdtemp(join(tmpdir(),'ja-e2e-'));
  let client: Client | undefined, app: ReturnType<typeof createApp> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    if (app) { app.closeAllConnections(); await new Promise<void>(r => app!.close(() => r())).catch(e=>failures.push(e)); }
    if (client) await client.close().catch(e=>failures.push(e));
    await rm(dir,{recursive:true,force:true}).catch(e=>failures.push(e));
    if (failures.length) throw new Error('E2E cleanup failed');
  };
  try {
    for (const [name,text] of Object.entries(profile.documents)) { const path=join(dir,'profile',name); await mkdir(dirname(path),{recursive:true}); await writeFile(path,text); }
    const file=join(dir,'applications.json'); await writeFile(file,JSON.stringify(profile.initialApplications));
    const store=new ApplicationStore(file,()=>new Date('2026-11-06T12:00:00Z')); await store.list();
    const tracer=new MemoryTracer();
    const scripted=opts.runtime==='scripted' ? scriptedProviders(opts.fault,opts.observe) : undefined;
    const env=opts.env ?? process.env;
    const baseParser=scripted ? new JdParsingService({extractor:scripted.extractor,timeoutMs:opts.fault==='parser_timeout'?20:1000}) : createJdParser({...env,JD_PARSER_CACHE_DIR:'off'},{offline:opts.runtime==='offline'});
    const parser=opts.parserReplay?{parse:async(text:string,signal?:AbortSignal)=>{signal?.throwIfAborted();if(hash(text)!==opts.parserReplay!.jdHash)throw new Error('Parser replay JD hash mismatch');return {data:structuredClone(opts.parserReplay!.data),meta:{method:'rules' as const,version:'e2e-replay-v1',cacheHit:true,ms:0,apiCalls:0,inputTokens:0,outputTokens:0,warnings:['Controlled replay; not fresh JD parsing.']}};}}:baseParser;
    const matching:MatchingOptions=scripted ? {mode:opts.matchMode,llm:scripted.llm,batchSize:opts.fault==='match_failure'?1:6,totalMs:5000,callMs:1000} : createMatching({...env,MATCH_MODE:opts.matchMode,MATCH_CACHE:'off'},opts.runtime==='offline');
    const llm=scripted?.llm ?? (opts.runtime==='live'?createLLM({},env):undefined);
    opts.signal?.throwIfAborted();
    const server=createServer(store,await ProfileIndex.fromDir(join(dir,'profile')),{jdParser:parser,tracer});
    client=new Client({name:'e2e-evaluation',version:'1'}); const [a,b]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a),client.connect(b)]);
    if (opts.fault==='search_failure') { const call=client.callTool.bind(client); client.callTool=(async (...args: Parameters<Client['callTool']>) => {if(args[0].name==='search_profile') throw new Error('ECONNRESET');return call(...args);}) as Client['callTool']; }
    app=createApp({client,store,llm,matching,tracer}); app.listen(0,'127.0.0.1'); await once(app,'listening');
    const address=app.address(); const base=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
    const config=await (await fetch(base+'/api/config',{signal:opts.signal})).json() as {token:string};
    const request=async (path:string,body?:unknown,signal?:AbortSignal) => {
      const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-App-Token':config.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([opts.signal??AbortSignal.timeout(240000),signal??AbortSignal.timeout(240000)])});
      return {status:res.status,data:await res.json() as any};
    };
    // Inspect physical records independently of application list/filter/mutation logic.
    const inspect=() => {const db=new DatabaseSync(store.databaseFile,{readOnly:true});try{return {applications:db.prepare('SELECT data FROM applications ORDER BY id').all().map(r=>JSON.parse(String(r.data))) as Record<string,unknown>[],operations:db.prepare('SELECT id,result,cancelled FROM operations ORDER BY id').all().map(r=>({...r}))};}finally{db.close();}};
    opts.signal?.throwIfAborted();
    const configuration={runtime:opts.runtime,experiment:opts.parserReplay?'matching_ablation':'full_workflow',matching:{mode:opts.runtime==='offline'?'retrieval':matching.mode,provider:matching.llm?.provider,model:matching.llm?.model,totalMs:matching.totalMs,callMs:matching.callMs,maxRounds:matching.maxRounds,maxSearches:matching.maxSearches},draft:{provider:llm?.provider,model:llm?.model},parser:{mode:opts.runtime==='offline'?'rules':scripted?'scripted':env.JD_PARSER_MODE??'auto',cache:'disabled per case'},retrieval:'bm25',matchingCache:'disabled',caseTimeoutMs:opts.caseTimeoutMs??240000};
    return {request,inspect,store,client,tracer,scripted,configuration,close};
  } catch(error) {await close().catch(()=>{});throw error;}
}
export type E2EEnvironment=Awaited<ReturnType<typeof createEnvironment>>;
