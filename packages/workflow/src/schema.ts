// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running',
  running           INTEGER NOT NULL DEFAULT 0,
  succeeded         INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  current_phase     TEXT,
  parent_run_id     TEXT,
  args              TEXT,
  script_sha        TEXT,
  agent_timeout_ms  INTEGER,
  max_steps         INTEGER NOT NULL DEFAULT 200,
  max_tokens        INTEGER NOT NULL DEFAULT 2000000,
  max_wall_clock_ms INTEGER NOT NULL DEFAULT 3600000,
  per_step_timeout_ms INTEGER NOT NULL DEFAULT 120000,
  error             TEXT,
  workspace         TEXT,
  time_created      INTEGER NOT NULL DEFAULT (unixepoch()),
  time_updated      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id      TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  input_prompt TEXT,
  output_result TEXT,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (run_id, step_index),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wf_steps_run ON workflow_steps(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON workflow_runs(status);
`

export function applySchema(db: import("bun:sqlite").Database): void {
  db.exec("PRAGMA journal_mode=WAL")
  db.exec(SCHEMA_SQL)
  // v0.13.0 — additive migration: workspace column for resume() to restore
  // the original lexical jail root across crashes. Idempotent guard via
  // PRAGMA table_info so re-running applySchema() is a no-op.
  const cols = db.query("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "workspace")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN workspace TEXT")
  }
}
