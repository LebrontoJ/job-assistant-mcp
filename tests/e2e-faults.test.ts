import { describe,it,expect } from 'vitest';
import { loadCases } from '../evals/e2e/load.js';
import { runCase } from '../evals/e2e/runner.js';
import type { Fault } from '../evals/e2e/types.js';
describe('e2e reliability track (not model quality)',()=>{
  for(const fault of ['parser_timeout','match_failure','search_failure','draft_failure','user_cancel','unapproved_write','version_conflict','lost_response'] as Fault[])it(fault,async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const result=await runCase(task,profile,{runtime:'scripted',matchMode:'agent',fault,artifacts:false});
    expect(result.errors).toEqual([]);expect(result.track).toBe('reliability');
    expect(result.outcome).toBe('passed');expect(result.checks.every(c=>c.dimension==='reliability')).toBe(true);
  });
  for(const workflow of ['cancel','no_decision','retry_same_key'] as const)it(workflow,async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const result=await runCase({...task,workflow},profile,{runtime:'scripted',matchMode:'agent',artifacts:false});
    expect(result.outcome).toBe('passed');expect(result.checks.filter(c=>c.dimension==='writing').every(c=>c.state==='pass')).toBe(true);
  });
});
