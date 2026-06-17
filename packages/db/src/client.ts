import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

if (!process.env.DATABASE_URL) {
  throw new Error('[db client] DATABASE_URL is required');
}

// A real transactional connection pool. The atomic punch relies on
// SELECT ... FOR UPDATE inside a transaction, which the prior Neon HTTP
// driver could not hold across statements.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });
export type Database = typeof db;
