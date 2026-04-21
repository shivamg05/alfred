import Database from "better-sqlite3";
import { config } from "../config.js";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (!_db) {
    _db = new Database(config().DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    applySchema(_db);
  }
  return _db;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imessage_row_id INTEGER UNIQUE,
      user_id TEXT NOT NULL DEFAULT 'local',
      raw_text TEXT,
      media_type TEXT NOT NULL DEFAULT 'text',  -- text | audio | image | file
      transcript TEXT,     -- for audio messages
      file_summary TEXT,   -- for image/file messages
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      text TEXT NOT NULL,
      root_fact_id INTEGER REFERENCES memory_facts(id),
      parent_fact_id INTEGER REFERENCES memory_facts(id),
      is_latest INTEGER NOT NULL DEFAULT 1,   -- 0 when superseded
      is_static INTEGER NOT NULL DEFAULT 0,   -- stable long-term fact
      is_forgotten INTEGER NOT NULL DEFAULT 0,
      document_date TEXT NOT NULL,            -- when message was sent
      event_date TEXT,                        -- when described event occurs
      forget_after TEXT,                      -- auto-expire date
      source_message_id INTEGER REFERENCES messages(id),
      chroma_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_facts_user ON memory_facts(user_id, is_latest, is_forgotten);
    CREATE INDEX IF NOT EXISTS idx_facts_static ON memory_facts(user_id, is_static, is_forgotten);

    CREATE TABLE IF NOT EXISTS fact_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id_a INTEGER NOT NULL REFERENCES memory_facts(id),
      fact_id_b INTEGER NOT NULL REFERENCES memory_facts(id),
      relation_type TEXT NOT NULL CHECK(relation_type IN ('updates', 'extends', 'derives')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      trigger_type TEXT NOT NULL,  -- morning_brief | midday_pulse | evening_wrap | reminder | connection
      content_sent TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
