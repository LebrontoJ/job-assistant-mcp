import { describe,expect,it } from 'vitest';
import { loadCases } from '../evals/e2e/load.js';
import { runCase } from '../evals/e2e/runner.js';
describe('real HTTP e2e harness',()=>{
  it('runs raw JD through MCP to a confirmed SQLite write without exposing gold to providers',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const canary='GOLD_ONLY_CANARY_831';const seen:string[]=[];
    const result=await runCase({...task,gold:{...task.gold,forbiddenClaims:[canary]}},profile,{runtime:'scripted',matchMode:'agent',observe:(_s,p)=>seen.push(p)});
    expect(result.errors).toEqual([]);expect(result.checks.filter(c=>c.dimension==='writing').every(c=>c.state==='pass')).toBe(true);
    expect(result.outcome).toBe('passed');expect(result.usage.parserCalls).toBe(1);
    expect(seen.length).toBeGreaterThan(2);expect(seen.join('')).not.toContain(canary);
    expect(result.stages.at(-1)?.name).toBe('cleanup');
  });
  it('records startup failures instead of aborting the suite',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const result=await runCase(task,profile,{runtime:'offline',matchMode:'retrieval',makeEnvironment:async()=>{throw new Error('fixture startup failed');}});
    expect(result.outcome).toBe('run_error');expect(result.errors[0]?.stage).toBe('startup');
  });
});
