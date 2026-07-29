import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --env-file=.env.local scripts/migrate.mjs <path-to-sql>');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const ddl = await readFile(file, 'utf8');

try {
  await sql.unsafe(ddl);
  console.log(`applied ${file}`);
} finally {
  await sql.end();
}
