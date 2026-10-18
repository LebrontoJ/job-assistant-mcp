import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { CaseSchema, RetrievalCaseSchema, type EvalCase, type RetrievalCase } from "./types.js";

async function readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  const out: T[] = [];
  (await readFile(file, "utf8")).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(schema.parse(JSON.parse(line)));
    } catch (err) {
      throw new Error(`${file}:${i + 1}: ${err instanceof Error ? err.message : err}`);
    }
  });
  return out;
}

/** Inlines `{{file:path}}` so long inputs (job descriptions) live in their own files. */
export async function expandTurn(turn: string): Promise<string> {
  const refs = [...turn.matchAll(/\{\{file:([^}]+)\}\}/g)];
  let out = turn;
  for (const m of refs) out = out.replace(m[0], (await readFile(m[1]!.trim(), "utf8")).trim());
  return out;
}

export async function loadCases(dir = "evals/cases"): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const cases: EvalCase[] = [];
  for (const f of files) cases.push(...(await readJsonl(join(dir, f), CaseSchema)));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`Duplicate eval case id "${c.id}"`);
    seen.add(c.id);
  }
  return Promise.all(cases.map(async (c) => ({ ...c, turns: await Promise.all(c.turns.map(expandTurn)) })));
}

export function loadRetrievalCases(file = "evals/retrieval.jsonl"): Promise<RetrievalCase[]> {
  return readJsonl(file, RetrievalCaseSchema);
}
