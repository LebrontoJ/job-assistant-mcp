import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertOperation, newOperation, type PendingOperation } from "./operations.js";
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
  version: z.number().int().positive().default(1),
});
export type Application = z.infer<typeof ApplicationSchema>;

export type NewApplication = Pick<Application, "company" | "role"> &
  Partial<Pick<Application, "status" | "url" | "appliedDate" | "nextFollowUp" | "notes">>;
export type ApplicationPatch = Partial<
  Pick<Application, "status" | "nextFollowUp" | "notes" | "url" | "appliedDate">
>;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** SQLite is authoritative. A .json input is imported once into a sibling .sqlite file, never overwritten. */
export class ApplicationStore {
  readonly databaseFile: string;
  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {
    this.databaseFile = file.endsWith('.json') ? `${file}.sqlite` : file;
  }

  private transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  private use<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(dirname(this.databaseFile), { recursive: true });
    const db = new DatabaseSync(this.databaseFile, { timeout: 5_000 });
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.transaction(db, () => {
        db.exec(`CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, data TEXT NOT NULL, result TEXT, cancelled INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        if (!db.prepare("SELECT value FROM metadata WHERE key='imported'").get()) {
          if (this.file.endsWith('.json') && existsSync(this.file)) {
            const apps = z.array(ApplicationSchema).parse(JSON.parse(readFileSync(this.file, 'utf8')));
            for (const app of apps) this.persist(db, app, true);
          }
          db.prepare("INSERT INTO metadata VALUES ('imported', '1')").run();
        }
      });
      return fn(db);
    } finally { db.close(); }
  }

  private identity(company: string, role: string): string { return JSON.stringify([company.trim().toLowerCase(), role.trim().toLowerCase()]); }
  private load(db: DatabaseSync): Application[] {
    return db.prepare('SELECT data FROM applications ORDER BY rowid').all().map(row => ApplicationSchema.parse(JSON.parse(String(row.data))));
  }
  private persist(db: DatabaseSync, app: Application, insert = false): void {
    if (insert) db.prepare('INSERT INTO applications (id, identity, data) VALUES (?, ?, ?)').run(app.id, this.identity(app.company, app.role), JSON.stringify(app));
    else db.prepare('UPDATE applications SET data=? WHERE id=?').run(JSON.stringify(app), app.id);
  }
  private addIn(db: DatabaseSync, input: NewApplication): Application {
    if (this.load(db).some(a => this.identity(a.company, a.role) === this.identity(input.company, input.role))) throw new Error('DUPLICATE_APPLICATION: use the existing application.');
    const stamp = this.now().toISOString();
    const app = ApplicationSchema.parse({ ...input, id: randomUUID(), company: input.company.trim(), role: input.role.trim(), status: input.status ?? 'wishlist', createdAt: stamp, updatedAt: stamp, version: 1 });
    this.persist(db, app, true);
    return app;
  }
  private updateIn(db: DatabaseSync, id: string, patch: ApplicationPatch, expectedVersion?: number): Application | undefined {
    const current = this.load(db).find(a => a.id === id);
    if (!current) return undefined;
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new Error('VERSION_CONFLICT: application changed after preview; request a new preview.');
    const app = ApplicationSchema.parse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined)), version: current.version + 1, updatedAt: this.now().toISOString() });
    this.persist(db, app);
    return app;
  }

  async list(filter: { status?: Status; company?: string } = {}): Promise<Application[]> {
    const company = filter.company?.toLowerCase();
    return this.use(db => this.load(db).filter(a => (!filter.status || a.status === filter.status) && (!company || a.company.toLowerCase().includes(company))));
  }
  async get(id: string): Promise<Application | undefined> { return this.use(db => this.load(db).find(a => a.id === id)); }
  async findDuplicate(company: string, role: string): Promise<Application | undefined> { return this.use(db => this.load(db).find(a => this.identity(a.company, a.role) === this.identity(company, role))); }
  async add(input: NewApplication): Promise<Application> { return this.use(db => this.transaction(db, () => this.addIn(db, input))); }
  async update(id: string, patch: ApplicationPatch, expectedVersion?: number): Promise<Application | undefined> { return this.use(db => this.transaction(db, () => this.updateIn(db, id, patch, expectedVersion))); }
  async followups(days = 7): Promise<Application[]> {
    const limit = new Date(this.now()); limit.setUTCDate(limit.getUTCDate() + days);
    const cutoff = isoDay(limit);
    return (await this.list()).filter(a => a.nextFollowUp && !TERMINAL.has(a.status) && a.nextFollowUp <= cutoff).sort((a,b) => (a.nextFollowUp ?? '').localeCompare(b.nextFollowUp ?? ''));
  }

  async prepareOperation(tool: string, args: Record<string, unknown>): Promise<PendingOperation> {
    return (await this.preparePreview(tool, args)).operation;
  }
  async preparePreview(tool: string, args: Record<string, unknown>): Promise<{ operation: PendingOperation; current?: Application }> {
    return this.use(db => this.transaction(db, () => {
      const current = tool === 'update_application' ? this.load(db).find(a => a.id === args.id) : undefined;
      if (tool === 'update_application' && !current) throw new Error('APPLICATION_NOT_FOUND');
      const op = newOperation(tool, args, current?.version);
      db.prepare('INSERT INTO operations (id, data) VALUES (?, ?)').run(op.id, JSON.stringify(op));
      return { operation: op, current };
    }));
  }
  async cancelOperation(id: string): Promise<boolean> {
    return this.use(db => this.transaction(db, () => {
      const row = db.prepare("SELECT result FROM operations WHERE id=?").get(id);
      if (!row || row.result) return false;
      db.prepare("UPDATE operations SET cancelled=1 WHERE id=? AND result IS NULL").run(id);
      return true;
    }));
  }
  async executeOperation(id: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.use(db => this.transaction(db, () => {
      const row = db.prepare('SELECT data, result, cancelled FROM operations WHERE id=?').get(id);
      if (!row) throw new Error('PREVIEW_REQUIRED: unknown operation.');
      const op: PendingOperation = JSON.parse(String(row.data));
      // Completed writes may be replayed after expiry, but never for a different payload.
      assertOperation(op, tool, args, row.result ? Math.min(Date.now(), op.expiresAt - 1) : Date.now());
      if (row.cancelled) throw new Error('APPROVAL_CANCELLED: request a new preview.');
      if (row.result) return JSON.parse(String(row.result));
      const application = tool === 'add_application'
        ? this.addIn(db, op.payload as NewApplication)
        : tool === 'update_application' ? this.updateIn(db, String(op.payload.id), op.payload as ApplicationPatch, op.expectedVersion) : undefined;
      if (!application) throw new Error('APPLICATION_NOT_FOUND');
      const result = { status: tool === 'add_application' ? 'created' : 'updated', application, operationId: id };
      db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), id);
      return result;
    }));
  }
}
