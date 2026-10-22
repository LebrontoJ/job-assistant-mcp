import { resolve } from 'node:path';
import { ApplicationStore } from '../src/store/applications.js';
const store = new ApplicationStore(resolve(process.argv[2] ?? process.env.APPLICATIONS_FILE ?? 'data/sample/applications.json'));
const rows = await store.list();
console.log(JSON.stringify({ database: store.databaseFile, importedRows: rows.length, sourcePreserved: true }));
