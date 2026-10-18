// Deterministic JD structuring. The server stays model-free on purpose: it splits the
// text into sections and pulls out checkable facts; judging fit is the agent's job.

export interface ParsedJd {
  title: string | null;
  company: string | null;
  location: string | null;
  workMode: "remote" | "hybrid" | "onsite" | null;
  minYearsExperience: number | null;
  responsibilities: string[];
  requirements: string[];
  niceToHave: string[];
  skills: string[];
}

type Section = "responsibilities" | "requirements" | "niceToHave" | "other";

const HEADINGS: Array<[Section, RegExp]> = [
  ["niceToHave", /nice to have|preferred|bonus|a plus|good to have/i],
  [
    "requirements",
    /requirements?|qualifications?|what you('|’)?ll need|what we('|’)?re looking for|must[- ]have|minimum|who you are/i,
  ],
  ["responsibilities", /responsibilit|what you('|’)?ll do|the role|your impact|day[- ]to[- ]day/i],
];

const SKILLS = [
  "TypeScript", "JavaScript", "Python", "Java", "Go", "Rust", "C++", "SQL", "React", "Node.js",
  "Next.js", "Vue", "Django", "Flask", "FastAPI", "Spring", "Docker", "Kubernetes", "AWS", "GCP",
  "Azure", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "GraphQL", "REST", "gRPC",
  "Terraform", "CI/CD", "Git", "Linux", "PyTorch", "TensorFlow", "LLM", "RAG", "MCP", "Spark",
  "Airflow", "dbt", "Tableau", "Pandas", "NumPy",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function matchSkills(text: string): string[] {
  return SKILLS.filter((skill) => {
    // \b doesn't work next to symbols such as "C++", so use explicit lookarounds.
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(skill)}(?![A-Za-z0-9])`, "i");
    return re.test(text);
  });
}

function classifyHeading(line: string): Section | null {
  const text = line.replace(/^#+\s*/, "").replace(/[:：*_]+$/g, "").trim();
  const looksLikeHeading =
    /^#+\s/.test(line) || /[:：]\s*$/.test(line) || (text.length <= 40 && !/^[-*•]/.test(line));
  if (!looksLikeHeading || text.length > 60) return null;
  for (const [section, re] of HEADINGS) if (re.test(text)) return section;
  return null;
}

export function parseJd(input: string): ParsedJd {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: ParsedJd = {
    title: null,
    company: null,
    location: null,
    workMode: null,
    minYearsExperience: null,
    responsibilities: [],
    requirements: [],
    niceToHave: [],
    skills: matchSkills(input),
  };

  out.title = lines[0]?.replace(/^#+\s*/, "").replace(/^(job title|title|position)\s*[:：]\s*/i, "") ?? null;

  const companyMatch =
    input.match(/^\s*company\s*[:：]\s*(.+)$/im) ??
    input.match(/\bjoin\s+([A-Z][\w&.\- ]{1,40}?)(?:\s+as\b|[,.!]|\s+and\b)/) ??
    input.match(/\bat\s+([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,2})\b/);
  out.company = companyMatch?.[1]?.trim() ?? null;

  out.location = input.match(/^\s*location\s*[:：]\s*(.+)$/im)?.[1]?.trim() ?? null;

  if (/\bhybrid\b/i.test(input)) out.workMode = "hybrid";
  else if (/\bremote\b/i.test(input)) out.workMode = "remote";
  else if (/\bon-?site\b|\bin[- ]office\b/i.test(input)) out.workMode = "onsite";

  const years = [...input.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi)].map((m) => Number(m[1]));
  out.minYearsExperience = years.length ? Math.min(...years) : null;

  let section: Section = "other";
  for (const line of lines.slice(1)) {
    const heading = classifyHeading(line);
    if (heading) {
      section = heading;
      continue;
    }
    const bullet = line.match(/^[-*•·]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (!bullet || section === "other") continue;
    out[section].push(bullet[1]!.trim());
  }
  return out;
}
