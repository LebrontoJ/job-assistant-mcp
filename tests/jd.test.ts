import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJd } from "../src/server/jd.js";

const jd = readFileSync("data/sample/jd-backend.txt", "utf8");

describe("parseJd", () => {
  const p = parseJd(jd);

  it("extracts header fields", () => {
    expect(p.title).toBe("Senior Backend Engineer");
    expect(p.company).toBe("Northwind Labs");
    expect(p.location).toBe("Austin, TX (Hybrid)");
    expect(p.workMode).toBe("hybrid");
    expect(p.minYearsExperience).toBe(5);
  });

  it("files bullets under the right section", () => {
    expect(p.responsibilities).toHaveLength(3);
    expect(p.requirements).toHaveLength(3);
    expect(p.niceToHave).toEqual(["Experience with Kafka", "Exposure to LLM or RAG systems"]);
  });

  it("recognises skills, including ones with symbols, without partial-word hits", () => {
    expect(p.skills).toEqual(expect.arrayContaining(["Go", "Python", "PostgreSQL", "Redis", "Kafka", "RAG", "CI/CD"]));
    expect(parseJd("We use C++ daily and Django. Gopher culture.").skills).toEqual(["C++", "Django"]);
  });

  it("does not crash on unstructured text", () => {
    const p2 = parseJd("Just some prose about a job with no structure at all.");
    expect(p2.requirements).toEqual([]);
    expect(p2.workMode).toBeNull();
  });
});
