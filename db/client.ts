import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Supabase transaction pooler (port 6543) does not support prepared
// statements — every client in this project must pass { prepare: false }.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — load it with --env-file=.env.local");
}

export const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
export type Db = typeof db;
