import { Database } from "bun:sqlite";
import type { MigrationRecord } from "../types/persistence.ts";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export class Migrator {
  private readonly db: Database;
  private readonly migrations: Migration[];

  constructor(db: Database, migrations: Migration[]) {
    this.db = db;

    const names = new Set<string>();
    for (const m of migrations) {
      if (names.has(m.name)) {
        throw new Error(`Duplicate migration name: ${m.name}`);
      }
      names.add(m.name);
    }

    this.migrations = [...migrations].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);

    const applied = this.getAppliedNames();

    for (const migration of this.migrations) {
      if (applied.has(migration.name)) {
        continue;
      }

      const transaction = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query("INSERT INTO migrations (name) VALUES (?)")
          .run(migration.name);
      });

      transaction();
    }
  }

  getAppliedMigrations(): MigrationRecord[] {
    return this.db
      .query<MigrationRecord>(
        "SELECT id, name, applied_at as appliedAt FROM migrations ORDER BY name"
      )
      .all();
  }

  private getAppliedNames(): Set<string> {
    const rows = this.db
      .query<{ name: string }>("SELECT name FROM migrations")
      .all();
    return new Set(rows.map((r) => r.name));
  }
}
