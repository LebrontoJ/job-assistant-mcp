import { cp, mkdir } from 'node:fs/promises';
await cp('src/app/public', 'dist/src/app/public', { recursive: true });
await mkdir('dist/data/sample', { recursive: true });
await cp('data/sample/jd-backend.txt', 'dist/data/sample/jd-backend.txt');
