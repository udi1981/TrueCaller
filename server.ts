import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { createServer } from "http";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const db = new Database("callers.db");

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT,
    caller_name TEXT,
    caller_role TEXT,
    summary TEXT,
    transcript TEXT,
    duration INTEGER,
    call_type TEXT NOT NULL DEFAULT 'incoming',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec("ALTER TABLE calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'incoming'"); } catch {}
try { db.exec("ALTER TABLE calls ADD COLUMN recording_timestamp_ms INTEGER DEFAULT 0"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER  PRIMARY KEY AUTOINCREMENT,
    call_id      INTEGER  NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    phone_number TEXT     NOT NULL,
    caller_name  TEXT     NOT NULL,
    text         TEXT     NOT NULL,
    due_category TEXT     NOT NULL DEFAULT 'no_deadline',
    due_ts       INTEGER,
    done         INTEGER  NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972') && digits.length >= 11) return '0' + digits.slice(3);
  return digits;
}

function computeDueTs(category: string): number | null {
  const now = new Date();
  if (category === 'today') {
    const t = new Date(now);
    t.setHours(18, 0, 0, 0);
    if (t.getTime() <= now.getTime()) {
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
    const day = t.getDay();
    const daysUntilFriday = (5 - day + 7) % 7 || 7;
    t.setDate(t.getDate() + daysUntilFriday);
    t.setHours(9, 0, 0, 0);
    return t.getTime();
  }
  return null;
}

// ─── Shared prompts ───────────────────────────────────────────────────────────

const TRANSCRIPTION_INSTR = `Transcribe the audio accurately in Hebrew.
If the audio is silent, contains only noise, or contains no clear speech, return an empty string.
Do NOT invent dialogue or guess what was said if it's not clear.`;

const SUMMARY_INSTR = `You are a personal assistant.
Your job is to analyze a phone call transcript and provide:
1. The caller's full name or how they should be identified (e.g., "הבן", "דוד כהן", "נציג הוט").
2. The caller's role or relationship (e.g., בן משפחה, לקוח, ספק, עו"ד, רו"ח, בנקאי, נציג שירות).
3. A short, narrative summary of the conversation in the third person.
4. "tasks": array of action items that the *user* (the phone owner, not the caller) committed to doing.
   Each task: { "text": "Hebrew 5-10 words", "due_category": "today"|"tomorrow"|"this_week"|"no_deadline" }
   Include ONLY things the user said they would do, not promises made by the other party.
   If no user commitments: return [].

Rules:
- Write ONLY in Hebrew.
- Be a detective: if someone says "היי אמא", the name is "הבן". If the user says "היי דוד", the name is "דוד".
- If a specific name or role is mentioned or can be strongly inferred, use it.
- Do NOT use "Speaker 1", "Speaker 2", "דובר" or "דוברת".
- The summary should be a short paragraph (2-4 sentences).
- The tone should be professional yet simple.
- Do NOT use bullet points in the summary.
- Do NOT invent information.
- If the name is absolutely not findable, use "לא ידוע".
- If the role is absolutely not clear, use "לא ידוע".

Output format: JSON
{
  "name": "string",
  "role": "string",
  "summary": "string",
  "tasks": [{"text": "string", "due_category": "today"|"tomorrow"|"this_week"|"no_deadline"}]
}`;

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get("/api/callers/:phone", (req, res) => {
  const { phone } = req.params;
  const norm = normalizePhone(phone);
  const variants = [...new Set([phone, norm])].filter(Boolean);
  const placeholders = variants.map(() => '?').join(', ');
  const caller = db.prepare(
    `SELECT * FROM calls WHERE phone_number IN (${placeholders}) AND phone_number != '' ORDER BY created_at DESC LIMIT 1`
  ).get(...variants);
  res.json(caller || null);
});

app.get("/api/recent", (req, res) => {
  const calls = db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT 50").all();
  res.json(calls);
});

app.get("/api/calls/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(id);
  if (!call) return res.status(404).json({ error: "Not found" });
  res.json(call);
});

app.delete("/api/calls/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    db.prepare("DELETE FROM tasks WHERE call_id = ?").run(id);
    db.prepare("DELETE FROM calls WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/calls/:id/summary", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { summary } = req.body;
  if (isNaN(id) || !summary) return res.status(400).json({ error: "Invalid id or summary" });
  try {
    db.prepare("UPDATE calls SET summary = ? WHERE id = ?").run(summary, id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/save-call", (req, res) => {
  const { phone_number, name, role, summary, transcript, duration, call_type, recording_timestamp_ms } = req.body;

  if (!phone_number || !summary) {
    return res.status(400).json({ error: "Missing phone number or summary" });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO calls (phone_number, caller_name, caller_role, summary, transcript, duration, call_type, recording_timestamp_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(
      phone_number,
      name || "Unknown",
      role || "לא ידוע",
      summary,
      transcript || "",
      duration || 0,
      call_type || 'incoming',
      recording_timestamp_ms || 0
    );

    // Notify all clients to refresh history
    io.emit("history-updated");

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error: any) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to save call data" });
  }
});

// Tasks endpoints
app.get("/api/tasks", (req, res) => {
  try {
    const tasks = db.prepare(
      `SELECT t.*, c.summary as summary
       FROM tasks t
       LEFT JOIN calls c ON t.call_id = c.id
       WHERE t.done=0 ORDER BY t.due_ts ASC NULLS LAST`
    ).all();
    res.json(tasks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/save-tasks", (req, res) => {
  const { callId, phone, name, tasks } = req.body;
  if (!callId || !Array.isArray(tasks)) {
    return res.status(400).json({ error: "Missing callId or tasks" });
  }
  try {
    const stmt = db.prepare(
      `INSERT INTO tasks (call_id, phone_number, caller_name, text, due_category, due_ts)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const saved: any[] = [];
    for (const t of tasks) {
      if (!t.text) continue;
      const due_ts = computeDueTs(t.due_category || 'no_deadline');
      const result = stmt.run(callId, phone || '', name || '', t.text, t.due_category || 'no_deadline', due_ts);
      saved.push({
        id: result.lastInsertRowid,
        call_id: callId,
        phone_number: phone || '',
        caller_name: name || '',
        text: t.text,
        due_category: t.due_category || 'no_deadline',
        due_ts,
        done: 0,
        created_at: new Date().toISOString(),
      });
    }
    res.json(saved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/task-done", (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    db.prepare("UPDATE tasks SET done=1 WHERE id=?").run(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tasks-done", (req, res) => {
  try {
    const tasks = db.prepare(
      `SELECT t.*, c.summary as summary
       FROM tasks t
       LEFT JOIN calls c ON t.call_id = c.id
       WHERE t.done=1 ORDER BY t.created_at DESC LIMIT 50`
    ).all();
    res.json(tasks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/task-undone", (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    db.prepare("UPDATE tasks SET done=0 WHERE id=?").run(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/calls-by-phone/:phone", (req, res) => {
  const { phone } = req.params;
  const norm = normalizePhone(phone);
  const variants = [...new Set([phone, norm])].filter(Boolean);
  const placeholders = variants.map(() => '?').join(', ');
  try {
    const calls = db.prepare(
      `SELECT * FROM calls WHERE phone_number IN (${placeholders}) ORDER BY created_at DESC`
    ).all(...variants);
    res.json(calls);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q as string) || '';
  if (!q.trim()) return res.json([]);
  const like = `%${q}%`;
  try {
    const calls = db.prepare(
      `SELECT * FROM calls
       WHERE caller_name LIKE ? OR summary LIKE ? OR transcript LIKE ?
       ORDER BY created_at DESC LIMIT 50`
    ).all(like, like, like);
    res.json(calls);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ai-search", async (req, res) => {
  const { question, transcripts } = req.body;
  if (!question) return res.status(400).json({ error: "Missing question" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const genAI = new GoogleGenAI({ apiKey });

    const context = Array.isArray(transcripts) && transcripts.length > 0
      ? transcripts.map((t: any, i: number) =>
          `[שיחה ${i + 1} — ${t.name} — ${t.phone_number || ''} — ${t.date}]\nסיכום: ${t.summary}\nתמלול: ${t.transcript}\nמשימות ממני: ${Array.isArray(t.tasks) ? t.tasks.join(' | ') || 'אין' : 'אין'}`
        ).join('\n\n---\n\n')
      : 'אין שיחות זמינות.';

    const systemInstruction = `אתה עוזר אישי שעונה על שאלות לגבי היסטוריית שיחות הטלפון של המשתמש. ענה בעברית. ענה בצורה שיחתית וישירה, כמו עוזר AI רגיל. אל תשתמש בסימוני markdown כלל — ללא ##, **, *, --, רשימות עם מקפים, או כל עיצוב אחר. טקסט רגיל בלבד. אם נשאלת שאלה ספציפית — ענה רק עליה בדיוק, בלי להוסיף את כל הסיכום. אם התבקשת לסכם — תן סיכום מלא. כשמתייחס לשיחה ספציפית, ציין את שם האיש והתאריך בתוך הטקסט.`;

    const prompt = `להלן היסטוריית שיחות הטלפון של המשתמש:\n\n${context}\n\nשאלת המשתמש: ${question}`;

    const response = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ parts: [{ text: prompt }] }],
      config: { systemInstruction, temperature: 0.3 },
    });

    res.json({ answer: response.text?.trim() || 'לא נמצא מידע רלוונטי.' });
  } catch (error: any) {
    console.error("ai-search error:", error);
    res.status(500).json({ error: error.message || "AI search failed" });
  }
});

// Process call audio: transcribe + summarize via Gemini (server-side, key never exposed)
app.post("/api/process-call", async (req, res) => {
  const { audio_base64, mime_type, incoming_name, last_role } = req.body;

  if (!audio_base64) {
    return res.status(400).json({ error: "Missing audio data" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  }

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const genAI = new GoogleGenAI({ apiKey });

    // 1. Transcribe
    const transResponse = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        parts: [
          { text: TRANSCRIPTION_INSTR },
          { inlineData: { data: audio_base64, mimeType: mime_type || "audio/webm" } }
        ]
      }]
    });
    const transcript = transResponse.text?.trim() || "";

    let detectedName = incoming_name || "לא ידוע";
    let detectedRole = last_role || "לא ידוע";
    let summary = "לא התקבל מידע ברור מהשיחה.";
    let tasks: { text: string; due_category: string }[] = [];

    if (transcript && transcript.length >= 5) {
      // 2. Summarize + identify + extract tasks
      const sumResponse = await genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ parts: [{ text: `Transcript:\n${transcript}\n\nNote: The user previously identified this number as "${incoming_name}" with role "${last_role || 'לא ידוע'}". Use this if the transcript doesn't provide a better name.` }] }],
        config: {
          systemInstruction: SUMMARY_INSTR,
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      });

      try {
        const result = JSON.parse(sumResponse.text || "{}");
        detectedName = result.name !== "לא ידוע" ? result.name : (incoming_name || "לא ידוע");
        detectedRole = result.role !== "לא ידוע" ? result.role : (last_role || "לא ידוע");
        summary = result.summary || "לא ניתן היה ליצור סיכום.";
        if (Array.isArray(result.tasks)) {
          tasks = result.tasks
            .filter((t: any) => t && typeof t.text === 'string' && t.text.length > 0)
            .map((t: any) => ({
              text: t.text,
              due_category: ['today', 'tomorrow', 'this_week', 'no_deadline'].includes(t.due_category)
                ? t.due_category
                : 'no_deadline',
            }));
        }
      } catch {
        summary = sumResponse.text || "שגיאה בפענוח הסיכום.";
      }
    }

    res.json({ transcript: transcript || "אין תמלול זמין", name: detectedName, role: detectedRole, summary, tasks });
  } catch (error: any) {
    console.error("process-call error:", error);
    res.status(500).json({ error: error.message || "Processing failed" });
  }
});

app.post("/api/resummarize", async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: "Missing transcript" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  const DETAILED_SUMMARY_INSTR = `ענה בעברית. בהינתן התמלול הבא של שיחה, צור סיכום מפורט ומלא בטקסט רגיל בלבד — ללא ##, **, *, רשימות עם מקפים, או כל סימוני markdown אחרים. כתוב פסקאות רגילות וזורמות. כלול את כל הנושאים שנדונו, מספרים/תאריכים/סכומים שצוינו, התחייבויות שנלקחו על ידי כל צד, שאלות שנשאלו ותשובות שניתנו, ומסקנות. הסיכום צריך להיות מפורט ומלא ככל שניתן. לא לקצר.`;

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const genAI = new GoogleGenAI({ apiKey });
    const response = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ parts: [{ text: `תמלול השיחה:\n\n${transcript}` }] }],
      config: { systemInstruction: DETAILED_SUMMARY_INSTR, temperature: 0.3 },
    });
    res.json({ summary: response.text?.trim() || "לא ניתן ליצור סיכום." });
  } catch (error: any) {
    console.error("resummarize error:", error);
    res.status(500).json({ error: error.message || "Re-summarization failed" });
  }
});

app.post("/api/ask-about-call", async (req, res) => {
  const { question, call: callData, audioBase64, mimeType } = req.body;
  if (!question || !callData) return res.status(400).json({ error: "Missing question or call" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const genAI = new GoogleGenAI({ apiKey });

    const systemInstruction = `אתה עוזר אישי שעונה על שאלות לגבי שיחת טלפון ספציפית. ענה בעברית. ענה בצורה שיחתית וישירה, כמו עוזר AI רגיל. אל תשתמש בסימוני markdown כלל — ללא ##, **, *, --, או כל עיצוב אחר. טקסט רגיל בלבד. ענה רק על מה שנשאל — אל תספר את כל הסיכום אם לא התבקשת. כלול מספרים, תאריכים, ציטוטים מדויקים רק כשרלוונטי לשאלה.`;

    let parts: any[];
    if (audioBase64 && mimeType) {
      parts = [
        { text: `השאלה: ${question}\n\nענה על השאלה על סמך ההקלטה הבאה:` },
        { inlineData: { data: audioBase64, mimeType } },
      ];
    } else {
      const fallbackNote = "הקלטה לא נמצאה — מסתמך על תמלול שמור.";
      parts = [{ text: `${fallbackNote}\n\nתמלול השיחה:\n${callData.transcript || 'אין תמלול'}\n\nשאלה: ${question}` }];
    }

    const response = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ parts }],
      config: { systemInstruction, temperature: 0.2 },
    });
    res.json({ answer: response.text?.trim() || "לא נמצאה תשובה." });
  } catch (error: any) {
    console.error("ask-about-call error:", error);
    res.status(500).json({ error: error.message || "Failed" });
  }
});

// Webhook to trigger an incoming call from external systems
app.post("/api/webhook/incoming-call", (req, res) => {
  const { phone_number, name } = req.body;

  console.log(`Webhook received: Incoming call from ${phone_number} (${name})`);

  // Broadcast to all connected web clients
  io.emit("incoming-call", {
    phone_number: phone_number || "052-0000000",
    name: name || "מתקשר לא מזוהה"
  });

  res.json({ success: true, message: "Call triggered on all clients" });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
