import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const rows = await sql`
  select extname from pg_extension where extname in ('postgis','pg_trgm')
`;
console.log(rows);
await sql.end();
