import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema/index.js';

if (!process.env.DATABASE_URL) {
  throw new Error('[db client] DATABASE_URL is required');
}

const sql = neon(process.env.DATABASE_URL);

export const db = drizzle({ client: sql, schema });
export type Database = typeof db;
