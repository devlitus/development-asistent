import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Migrator } from "../../src/persistence/migrator.ts";

describe("Migrator", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("should create migrations table on first run", () => {
    const migrator = new Migrator(db, []);
    migrator.migrate();

    const tables = db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
      )
      .all();

    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe("migrations");
  });

  it("should apply all migrations when table is empty", () => {
    const migrations = [
      { name: "001_initial.sql", sql: "CREATE TABLE test1 (id INTEGER PRIMARY KEY);" },
      { name: "002_add_column.sql", sql: "ALTER TABLE test1 ADD COLUMN name TEXT;" },
    ];

    const migrator = new Migrator(db, migrations);
    migrator.migrate();

    const applied = migrator.getAppliedMigrations();
    expect(applied.length).toBe(2);
    expect(applied[0].name).toBe("001_initial.sql");
    expect(applied[1].name).toBe("002_add_column.sql");

    // Verify schema was applied
    const cols = db
      .query<{ name: string }>("PRAGMA table_info(test1)")
      .all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
  });

  it("should skip already applied migrations", () => {
    const migrations = [
      { name: "001_initial.sql", sql: "CREATE TABLE test2 (id INTEGER PRIMARY KEY);" },
    ];

    const migrator1 = new Migrator(db, migrations);
    migrator1.migrate();

    // Second migrator with same migration should skip
    const migrator2 = new Migrator(db, migrations);
    migrator2.migrate();

    const applied = migrator2.getAppliedMigrations();
    expect(applied.length).toBe(1);
  });

  it("should apply only new migrations", () => {
    const first = [{ name: "001_initial.sql", sql: "CREATE TABLE test3 (id INTEGER PRIMARY KEY);" }];
    const migrator1 = new Migrator(db, first);
    migrator1.migrate();

    const second = [
      ...first,
      { name: "002_add_data.sql", sql: "INSERT INTO test3 (id) VALUES (42);" },
    ];
    const migrator2 = new Migrator(db, second);
    migrator2.migrate();

    const applied = migrator2.getAppliedMigrations();
    expect(applied.length).toBe(2);

    const rows = db.query<{ id: number }>("SELECT id FROM test3").all();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(42);
  });

  it("should run migrations in order by name", () => {
    const migrations = [
      { name: "002_second.sql", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
      { name: "001_first.sql", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
    ];

    const migrator = new Migrator(db, migrations);
    migrator.migrate();

    const applied = migrator.getAppliedMigrations();
    expect(applied[0].name).toBe("001_first.sql");
    expect(applied[1].name).toBe("002_second.sql");
  });

  it("should throw on duplicate migration names", () => {
    const migrations = [
      { name: "001_dup.sql", sql: "SELECT 1;" },
      { name: "001_dup.sql", sql: "SELECT 2;" },
    ];

    expect(() => new Migrator(db, migrations)).toThrow(/duplicate/i);
  });

  it("should throw if a migration fails", () => {
    const migrations = [
      { name: "001_bad.sql", sql: "CREATE TABLE bad (id); INVALID SQL;" },
    ];

    const migrator = new Migrator(db, migrations);
    expect(() => migrator.migrate()).toThrow();
  });

  it("should not leave partial state or migration record on failure", () => {
    const migrations = [
      { name: "001_bad.sql", sql: "CREATE TABLE bad (id INTEGER PRIMARY KEY); INVALID SQL HERE;" },
    ];

    const migrator = new Migrator(db, migrations);
    expect(() => migrator.migrate()).toThrow();

    // Table creation should be rolled back (transaction)
    const tables = db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bad'"
      )
      .all();
    expect(tables.length).toBe(0);

    // No migration records should exist
    const applied = migrator.getAppliedMigrations();
    expect(applied.length).toBe(0);
  });
});
