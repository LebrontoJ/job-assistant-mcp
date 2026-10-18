import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const STATUSES = [
  "wishlist",
  "applied",
  "oa",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

const TERMINAL: ReadonlySet<Status> = new Set(["offer", "rejected", "withdrawn"]);

export const ApplicationSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  status: StatusSchema,
  url: z.string().optional(),
  appliedDate: z.string().optional(),
  nextFollowUp: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export type NewApplication = Pick<Application, "company" | "role"> &
  Partial<Pick<Application, "status" | "url" | "appliedDate" | "nextFollowUp" | "notes">>;
export type ApplicationPatch = Partial<
  Pick<Application, "status" | "nextFollowUp" | "notes" | "url" | "appliedDate">
>;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class ApplicationStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(filter: { status?: Status; company?: string } = {}): Promise<Application[]> {
    const all = await this.load();
    const company = filter.company?.toLowerCase();
    return all.filter(
      (a) =>
        (!filter.status || a.status === filter.status) &&
        (!company || a.company.toLowerCase().includes(company)),
    );
  }

  async get(id: string): Promise<Application | undefined> {
    return (await this.load()).find((a) => a.id === id);
  }

  /** Finds an existing row for the same company + role (case-insensitive). */
  async findDuplicate(company: string, role: string): Promise<Application | undefined> {
    const c = company.trim().toLowerCase();
    const r = role.trim().toLowerCase();
    return (await this.load()).find(
      (a) => a.company.toLowerCase() === c && a.role.toLowerCase() === r,
    );
  }

  async add(input: NewApplication): Promise<Application> {
    const all = await this.load();
    const stamp = this.now().toISOString();
    const app: Application = {
      id: randomUUID().slice(0, 8),
      company: input.company.trim(),
      role: input.role.trim(),
      status: input.status ?? "wishlist",
      url: input.url,
      appliedDate: input.appliedDate,
      nextFollowUp: input.nextFollowUp,
      notes: input.notes,
      createdAt: stamp,
      updatedAt: stamp,
    };
    all.push(app);
    await this.save(all);
    return app;
  }

  async update(id: string, patch: ApplicationPatch): Promise<Application | undefined> {
    const all = await this.load();
    const idx = all.findIndex((a) => a.id === id);
    const current = all[idx];
    if (idx === -1 || !current) return undefined;
    const next: Application = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      updatedAt: this.now().toISOString(),
    };
    all[idx] = next;
    await this.save(all);
    return next;
  }

  /** Open applications whose follow-up date is today or earlier, or within `days`. */
  async followups(days = 7): Promise<Application[]> {
    const limit = new Date(this.now());
    limit.setUTCDate(limit.getUTCDate() + days);
    const cutoff = isoDay(limit);
    return (await this.load())
      .filter((a) => a.nextFollowUp && !TERMINAL.has(a.status) && a.nextFollowUp <= cutoff)
      .sort((a, b) => (a.nextFollowUp ?? "").localeCompare(b.nextFollowUp ?? ""));
  }

  private async load(): Promise<Application[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return z.array(ApplicationSchema).parse(JSON.parse(raw));
  }

  private async save(apps: Application[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(apps, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}
