import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationStore } from '../src/store/applications.js';
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ja-tx-')); file = join(dir, 'apps.json'); await writeFile(file, '[]'); });
afterEach(() => rm(dir, { recursive: true, force: true }));
describe('transactional tracker', () => {
  it('imports once and preserves source; concurrent connections do not lose additions', async () => {
    const a = new ApplicationStore(file), b = new ApplicationStore(file);
    await Promise.all(Array.from({ length: 20 }, (_,i) => (i%2 ? a : b).add({ company: `C${i}`, role: 'SWE' })));
    expect(await new ApplicationStore(file).list()).toHaveLength(20);
    expect(await readFile(file, 'utf8')).toBe('[]');
  });
  it('serializes independent writer processes', async () => {
    const store = new ApplicationStore(file);
    await store.list();
    const moduleUrl = pathToFileURL(resolve('src/store/applications.ts')).href;
    await Promise.all([0, 1, 2].map(worker => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { ApplicationStore } from ${JSON.stringify(moduleUrl)}; const store = new ApplicationStore(${JSON.stringify(file)}); for(let i=0;i<8;i++) await store.add({company:'W${worker}-'+i,role:'SWE'});`])));
    expect(await store.list()).toHaveLength(24);
  });
  it('replays the original result after restart and rejects same key with a different payload', async () => {
    const args = { company: 'Acme', role: 'SWE' };
    const a = new ApplicationStore(file);
    const op = await a.prepareOperation('add_application', args);
    const result = await a.executeOperation(op.id, 'add_application', args);
    const b = new ApplicationStore(file);
    expect(await b.executeOperation(op.id, 'add_application', args)).toEqual(result);
    await expect(b.executeOperation(op.id, 'add_application', { ...args, notes: 'changed' })).rejects.toThrow('PAYLOAD_CHANGED');
    expect(await b.list()).toHaveLength(1);
  });
  it('rejects stale previews and does not partially commit their operation', async () => {
    const a = new ApplicationStore(file);
    const app = await a.add({ company: 'Acme', role: 'SWE' });
    const args = { id: app.id, status: 'interview' };
    const op = await a.prepareOperation('update_application', args);
    await a.update(app.id, { notes: 'changed since preview' });
    await expect(a.executeOperation(op.id, 'update_application', args)).rejects.toThrow('VERSION_CONFLICT');
    expect((await a.get(app.id))?.status).toBe('wishlist');
  });
  it('enforces cancellation durably and rolls back duplicate writes', async () => {
    const a = new ApplicationStore(file), args = { company: 'Acme', role: 'SWE' };
    const cancelled = await a.prepareOperation('add_application', args);
    await a.cancelOperation(cancelled.id);
    await expect(new ApplicationStore(file).executeOperation(cancelled.id, 'add_application', args)).rejects.toThrow('APPROVAL_CANCELLED');
    await a.add(args);
    await expect(a.add({ company: ' acme ', role: 'swe' })).rejects.toThrow('DUPLICATE');
    expect(await a.list()).toHaveLength(1);
  });
});
