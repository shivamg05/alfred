/**
 * Test setup: provides an in-memory SQLite database with Alfred's full schema
 * and stubs out config() / db() so every module that imports them gets the test
 * versions instead of hitting real files or env vars.
 *
 * Usage in each test file:
 *   import { setupTestDb, teardownTestDb, testConfig } from "./setup.js";
 *   beforeEach(() => setupTestDb());
 *   afterEach(() => teardownTestDb());
 */

import Database from "better-sqlite3";
import { vi } from "vitest";

// ---------- Config stub ----------

export const testConfig = {
  ALFRED_PHONE: "+15551234567",
  USER_PHONE: "+15559876543",
  OPENAI_API_KEY: "test-key",
  LLM_BASE_URL: "https://fake.openrouter.ai/api/v1",
  LLM_MODEL: "test-model",
  EXTRACTION_MODEL: "test-extraction-model",
  DB_PATH: ":memory:",
  IMESSAGE_DB_PATH: "/tmp/fake-chat.db",
  CHROMA_PATH: "./test_chroma",
  CHROMA_PORT: 8000,
  QUIET_HOURS_START: 23,
  QUIET_HOURS_END: 8,
  USER_TIMEZONE: "America/New_York",
  USER_ID: "local",
  TODOIST_API_TOKEN: undefined,
  FIRECRAWL_API_KEY: undefined,
  OPENROUTER_SITE_URL: undefined,
  OPENROUTER_SITE_NAME: undefined,
};

// We mock the config module so all imports of config() return testConfig.
vi.mock("../src/config.js", () => ({
  config: () => testConfig,
}));

// ---------- DB singleton ----------

let _testDb: Database.Database | null = null;

/** Returns the current test database (creates if needed). */
export function getTestDb(): Database.Database {
  if (!_testDb) throw new Error("setupTestDb() not called");
  return _testDb;
}

// We mock the db/schema module so all imports of db() return our in-memory instance.
vi.mock("../src/db/schema.js", () => ({
  db: () => {
    if (!_testDb) throw new Error("setupTestDb() not called");
    return _testDb;
  },
}));

/** Create a fresh in-memory database with the full schema. Call in beforeEach. */
export function setupTestDb(): Database.Database {
  _testDb = new Database(":memory:");
  _testDb.pragma("journal_mode = WAL");
  _testDb.pragma("foreign_keys = ON");
  applyFullSchema(_testDb);
  return _testDb;
}

/** Close the test database. Call in afterEach. */
export function teardownTestDb(): void {
  if (_testDb) {
    _testDb.close();
    _testDb = null;
  }
}

// ---------- Full schema (mirrors src/db/schema.ts through v6) ----------

function applyFullSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imessage_row_id INTEGER UNIQUE,
      user_id TEXT NOT NULL DEFAULT 'local',
      raw_text TEXT,
      media_type TEXT NOT NULL DEFAULT 'text',
      transcript TEXT,
      file_summary TEXT,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      text TEXT NOT NULL,
      root_fact_id INTEGER REFERENCES memory_facts(id),
      parent_fact_id INTEGER REFERENCES memory_facts(id),
      is_latest INTEGER NOT NULL DEFAULT 1,
      is_static INTEGER NOT NULL DEFAULT 0,
      is_forgotten INTEGER NOT NULL DEFAULT 0,
      document_date TEXT NOT NULL,
      event_date TEXT,
      forget_after TEXT,
      source_message_id INTEGER REFERENCES messages(id),
      chroma_id TEXT,
      abstraction_level INTEGER NOT NULL DEFAULT 1,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      proactive_after TEXT,
      proactive_fired_at TEXT,
      pattern_observation_queued INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_facts_user ON memory_facts(user_id, is_latest, is_forgotten);
    CREATE INDEX IF NOT EXISTS idx_facts_static ON memory_facts(user_id, is_static, is_forgotten);
    CREATE INDEX IF NOT EXISTS idx_facts_level
      ON memory_facts(user_id, abstraction_level, is_latest, is_forgotten);
    CREATE INDEX IF NOT EXISTS idx_facts_nudge
      ON memory_facts(user_id, proactive_after, proactive_fired_at)
      WHERE proactive_after IS NOT NULL;

    CREATE TABLE IF NOT EXISTS fact_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id_a INTEGER NOT NULL REFERENCES memory_facts(id),
      fact_id_b INTEGER NOT NULL REFERENCES memory_facts(id),
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fact_id_a, fact_id_b, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_fact_relations_a ON fact_relations(fact_id_a, relation_type);
    CREATE INDEX IF NOT EXISTS idx_fact_relations_b ON fact_relations(fact_id_b, relation_type);

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      fired_at TEXT,
      source_message_id INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(user_id, due_at) WHERE fired_at IS NULL;

    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      fact TEXT NOT NULL,
      is_static INTEGER NOT NULL DEFAULT 0,
      source_fact_id INTEGER REFERENCES memory_facts(id),
      last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, fact)
    );

    CREATE TABLE IF NOT EXISTS proactive_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      trigger_type TEXT NOT NULL,
      content_sent TEXT NOT NULL,
      source_fact_id INTEGER REFERENCES memory_facts(id),
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proactive_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      trigger_type TEXT NOT NULL,
      trigger TEXT,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      candidate TEXT,
      context_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_attempts_created
      ON proactive_attempts(user_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts
      USING fts5(text, content='memory_facts', content_rowid='id', tokenize='unicode61');

    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_insert
      AFTER INSERT ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(rowid, text) VALUES (new.id, new.text);
      END;

    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_update
      AFTER UPDATE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO memory_facts_fts(rowid, text) VALUES (new.id, new.text);
      END;

    CREATE TRIGGER IF NOT EXISTS memory_facts_fts_delete
      AFTER DELETE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;

    CREATE TABLE IF NOT EXISTS cron_state (
      job_name TEXT PRIMARY KEY,
      last_ran_at TEXT NOT NULL
    );
  `);
  db.pragma("user_version = 6");
}
