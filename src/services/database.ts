/**
 * Database service — wraps @capacitor-community/sqlite on Android,
 * falls back to the Express REST API when running in a browser (npm run dev).
 */
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

export interface Call {
  id: number;
  phone_number: string;
  caller_name: string;
  caller_role: string;
  summary: string;
  transcript: string;
  duration: number;
  created_at: string;
  call_type: 'incoming' | 'outgoing';
  recording_timestamp_ms?: number;
}

export interface TaskInput {
  text: string;
  due_category: 'today' | 'tomorrow' | 'this_week' | 'no_deadline';
}

export interface Task {
  id: number;
  call_id: number;
  phone_number: string;
  caller_name: string;
  text: string;
  due_category: 'today' | 'tomorrow' | 'this_week' | 'no_deadline';
  due_ts: number | null;
  done: number;
  created_at: string;
  summary?: string;
}

const DB_NAME = 'truesummary';

const CREATE_CALLS_SQL = `
  CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT,
    caller_name  TEXT,
    caller_role  TEXT,
    summary      TEXT,
    transcript   TEXT,
    duration     INTEGER,
    call_type    TEXT     NOT NULL DEFAULT 'incoming',
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  )
`;

const CREATE_TASKS_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER  PRIMARY KEY AUTOINCREMENT,
    call_id      INTEGER  NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    phone_number TEXT     NOT NULL,
    caller_name  TEXT     NOT NULL,
    text         TEXT     NOT NULL,
    due_category TEXT     NOT NULL DEFAULT 'no_deadline',
    due_ts       INTEGER,
    done         INTEGER  NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  )
`;

let db: SQLiteDBConnection | null = null;
let sqlite: SQLiteConnection | null = null;
let initPromise: Promise<void> | null = null;

async function ensureDb(): Promise<SQLiteDBConnection | null> {
  if (db) return db;
  if (!Capacitor.isNativePlatform()) return null;
  // Always retry init when db is null (serialized via shared promise)
  if (!initPromise) {
    initPromise = initDatabase()
      .catch(e => console.error('[database] ensureDb init failed:', e))
      .finally(() => { initPromise = null; });
  }
  await initPromise;
  return db;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return; // Web mode uses server API

  if (!sqlite) {
    sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
  const isConsistent = (await sqlite.checkConnectionsConsistency()).result;

  if (isConsistent && isConn) {
    db = await sqlite.retrieveConnection(DB_NAME, false);
  } else {
    db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  }

  await db.open();
  await db.execute(CREATE_CALLS_SQL);
  try {
    await db.execute("ALTER TABLE calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'incoming'");
  } catch { /* column already exists on upgrade */ }
  try {
    await db.execute("ALTER TABLE calls ADD COLUMN recording_timestamp_ms INTEGER DEFAULT 0");
  } catch { /* column already exists on upgrade */ }
  await db.execute(CREATE_TASKS_SQL);
}

export async function getRecentCalls(limit = 50): Promise<Call[]> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/recent');
    if (!res.ok) throw new Error('Failed to fetch recent calls');
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) {
    console.error('[database] getRecentCalls: ensureDb returned null');
    return [];
  }
  const result = await conn.query(
    'SELECT * FROM calls ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  const rows = (result.values ?? []) as Call[];
  console.log(`[database] getRecentCalls: returned ${rows.length} rows`);
  return rows;
}

// local helper — keeps database.ts self-contained
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972') && digits.length >= 11) return '0' + digits.slice(3);
  return digits;
}

export async function getCallerByPhone(phone: string): Promise<Call | null> {
  const norm = normalizePhone(phone);
  const variants = [...new Set([phone, norm])].filter(Boolean);

  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/callers/${encodeURIComponent(phone)}`);
    if (!res.ok) return null;
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return null;
  const placeholders = variants.map(() => '?').join(', ');
  const result = await conn.query(
    `SELECT * FROM calls WHERE phone_number IN (${placeholders}) AND phone_number != ''
     ORDER BY created_at DESC LIMIT 1`,
    variants
  );
  const rows = result.values ?? [];
  return rows.length > 0 ? (rows[0] as Call) : null;
}

export async function saveCall(params: {
  phone_number: string;
  caller_name: string;
  caller_role: string;
  summary: string;
  transcript: string;
  duration: number;
  call_type: 'incoming' | 'outgoing';
  recordingTimestampMs?: number;
}): Promise<{ id: number }> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/save-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number:           params.phone_number,
        name:                   params.caller_name,
        role:                   params.caller_role,
        summary:                params.summary,
        transcript:             params.transcript,
        duration:               params.duration,
        call_type:              params.call_type,
        recording_timestamp_ms: params.recordingTimestampMs ?? 0,
      }),
    });
    const data = await res.json();
    return { id: data.id as number };
  }

  const conn = await ensureDb();
  if (!conn) {
    console.error('[database] saveCall: ensureDb returned null — call NOT saved');
    return { id: 0 };
  }
  // Use recording timestamp as created_at when available (scanned calls),
  // otherwise use current time (real-time calls)
  const tsMs = params.recordingTimestampMs ?? 0;
  const createdAt = tsMs > 0
    ? new Date(tsMs).toISOString().replace('T', ' ').replace('Z', '')
    : null;

  const result = await conn.run(
    `INSERT INTO calls
       (phone_number, caller_name, caller_role, summary, transcript, duration, call_type, recording_timestamp_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${createdAt ? '?' : "datetime('now','localtime')"})`,
    [
      params.phone_number,
      params.caller_name,
      params.caller_role,
      params.summary,
      params.transcript,
      params.duration,
      params.call_type,
      tsMs,
      ...(createdAt ? [createdAt] : []),
    ]
  );
  const id = result.changes?.lastId ?? 0;
  console.log(`[database] saveCall: inserted id=${id}, changes=${JSON.stringify(result.changes)}`);
  return { id };
}

export async function getCallById(id: number): Promise<Call | null> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/calls/${id}`);
    if (!res.ok) return null;
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return null;
  const result = await conn.query('SELECT * FROM calls WHERE id = ?', [id]);
  const rows = result.values ?? [];
  return rows.length > 0 ? (rows[0] as Call) : null;
}

export async function deleteCall(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/calls/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete call');
    return;
  }

  const conn = await ensureDb();
  if (!conn) return;
  await conn.run('DELETE FROM tasks WHERE call_id = ?', [id]);
  await conn.run('DELETE FROM calls WHERE id = ?', [id]);
}

export async function updateCallSummary(id: number, summary: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await fetch(`/api/calls/${id}/summary`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });
    return;
  }

  const conn = await ensureDb();
  if (!conn) return;
  await conn.run('UPDATE calls SET summary = ? WHERE id = ?', [summary, id]);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Compute a Unix-ms timestamp for a due category.
 * "today"     → 18:00 today (or +3h if past 15:00)
 * "tomorrow"  → 09:00 next day
 * "this_week" → 09:00 next Friday
 * "no_deadline" → null
 */
export function computeDueTs(category: TaskInput['due_category']): number | null {
  const now = new Date();
  if (category === 'today') {
    const t = new Date(now);
    t.setHours(18, 0, 0, 0);
    if (t.getTime() <= now.getTime()) {
      // Past 18:00 — schedule 3h from now
      return now.getTime() + 3 * 60 * 60 * 1000;
    }
    return t.getTime();
  }
  if (category === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.getTime();
  }
  if (category === 'this_week') {
    const t = new Date(now);
    const day = t.getDay(); // 0=Sun, 5=Fri
    const daysUntilFriday = (5 - day + 7) % 7 || 7; // next Friday (not today)
    t.setDate(t.getDate() + daysUntilFriday);
    t.setHours(9, 0, 0, 0);
    return t.getTime();
  }
  return null;
}

export async function saveTasks(
  callId: number,
  phone: string,
  name: string,
  tasks: TaskInput[]
): Promise<Task[]> {
  const saved: Task[] = [];

  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/save-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, phone, name, tasks }),
    });
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return [];
  for (const t of tasks) {
    const due_ts = computeDueTs(t.due_category);
    const result = await conn.run(
      `INSERT INTO tasks (call_id, phone_number, caller_name, text, due_category, due_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [callId, phone, name, t.text, t.due_category, due_ts]
    );
    const id = result.changes?.lastId ?? 0;
    saved.push({
      id,
      call_id:      callId,
      phone_number: phone,
      caller_name:  name,
      text:         t.text,
      due_category: t.due_category,
      due_ts,
      done:         0,
      created_at:   new Date().toISOString(),
    });
  }
  return saved;
}

export async function getPendingTasks(): Promise<Task[]> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Failed to fetch tasks');
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return [];
  const result = await conn.query(
    `SELECT t.*, c.summary as summary
     FROM tasks t
     LEFT JOIN calls c ON t.call_id = c.id
     WHERE t.done=0 ORDER BY t.due_ts ASC NULLS LAST`
  );
  return (result.values ?? []) as Task[];
}

export async function markTaskDone(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await fetch('/api/task-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return;
  }

  const conn = await ensureDb();
  if (!conn) return;
  await conn.run('UPDATE tasks SET done=1 WHERE id=?', [id]);
}

export async function getCompletedTasks(): Promise<Task[]> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/tasks-done');
    if (!res.ok) throw new Error('Failed to fetch completed tasks');
    return res.json();
  }
  const conn = await ensureDb();
  if (!conn) return [];
  const result = await conn.query(
    `SELECT t.*, c.summary as summary
     FROM tasks t
     LEFT JOIN calls c ON t.call_id = c.id
     WHERE t.done=1 ORDER BY t.created_at DESC LIMIT 50`
  );
  return (result.values ?? []) as Task[];
}

export async function deleteTask(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete task');
    return;
  }
  const conn = await ensureDb();
  if (!conn) return;
  await conn.run('DELETE FROM tasks WHERE id = ?', [id]);
}

export async function markTaskUndone(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await fetch('/api/task-undone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return;
  }
  const conn = await ensureDb();
  if (!conn) return;
  await conn.run('UPDATE tasks SET done=0 WHERE id=?', [id]);
}

export async function getCallsByPhone(phone: string): Promise<Call[]> {
  const norm = normalizePhone(phone);
  const variants = [...new Set([phone, norm])].filter(Boolean);

  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/calls-by-phone/${encodeURIComponent(phone)}`);
    if (!res.ok) throw new Error('Failed to fetch calls by phone');
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return [];
  const placeholders = variants.map(() => '?').join(', ');
  const result = await conn.query(
    `SELECT * FROM calls WHERE phone_number IN (${placeholders}) ORDER BY created_at DESC`,
    variants
  );
  return (result.values ?? []) as Call[];
}

/**
 * Returns all distinct non-empty phone numbers stored in the calls table.
 * Used by the contact-name sync to iterate and look up each number.
 */
export async function getAllDistinctPhones(): Promise<string[]> {
  if (!Capacitor.isNativePlatform()) return [];
  const conn = await ensureDb();
  if (!conn) return [];
  const result = await conn.query(
    "SELECT DISTINCT phone_number FROM calls WHERE phone_number IS NOT NULL AND phone_number != '' ORDER BY phone_number"
  );
  return (result.values ?? []).map((row: any) => row.phone_number as string);
}

/**
 * Updates caller_name for every call row that has the given phone_number.
 * Used by the contact-name sync to overwrite AI-detected names with real contact names.
 */
export async function updateCallerNameByPhone(phone: string, name: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const conn = await ensureDb();
  if (!conn) return;
  const norm = normalizePhone(phone);
  const variants = [...new Set([phone, norm])].filter(Boolean);
  const placeholders = variants.map(() => '?').join(', ');
  await conn.run(
    `UPDATE calls SET caller_name = ? WHERE phone_number IN (${placeholders})`,
    [name, ...variants]
  );
}

export async function searchCalls(query: string): Promise<Call[]> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Failed to search calls');
    return res.json();
  }

  const conn = await ensureDb();
  if (!conn) return [];
  const like = `%${query}%`;
  const result = await conn.query(
    'SELECT * FROM calls WHERE caller_name LIKE ? OR summary LIKE ? OR transcript LIKE ? ORDER BY created_at DESC LIMIT 50',
    [like, like, like]
  );
  return (result.values ?? []) as Call[];
}
