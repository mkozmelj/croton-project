import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import * as schema from "./schema.js";

export type Database = NeonHttpDatabase<typeof schema>;

export function createDatabase(databaseUrl: string): Database {
  return drizzle({ client: neon(databaseUrl), schema });
}

// Stack doc §8: migrations run on boot, so a fresh deploy is always schema-correct.
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
