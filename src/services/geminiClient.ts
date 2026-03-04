/**
 * Gemini client service — calls Gemini directly on Android (API key from Preferences),
 * falls back to the Express /api/process-call endpoint when running in a browser.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { Call, TaskInput } from './database';

// ─── Prompts (identical to server.ts) ────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getApiKey(): Promise<string> {
  try {
    const { value } = await Preferences.get({ key: 'gemini_api_key' });
    if (value) return value;
  } catch {
    // Preferences unavailable in web mode — key comes from server .env
  }
  return '';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function processCallAudio(params: {
  audioBase64: string;
  mimeType: string;
  incomingName: string;
  lastRole: string;
}): Promise<{ transcript: string; name: string; role: string; summary: string; tasks: TaskInput[] }> {

  // ── Web / dev mode: delegate to Express server ──────────────────────────
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/process-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64:  params.audioBase64,
        mime_type:     params.mimeType,
        incoming_name: params.incomingName,
        last_role:     params.lastRole,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }
    const data = await res.json();
    return {
      transcript: data.transcript,
      name:       data.name,
      role:       data.role,
      summary:    data.summary,
      tasks:      Array.isArray(data.tasks) ? data.tasks : [],
    };
  }

  // ── Native mode: call Gemini directly ───────────────────────────────────
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('מפתח Gemini API לא מוגדר. פתח הגדרות והזן את המפתח.');
  }

  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey });

  // Step 1 – Transcribe
  const transResponse = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{
      parts: [
        { text: TRANSCRIPTION_INSTR },
        { inlineData: { data: params.audioBase64, mimeType: params.mimeType } },
      ],
    }],
  });
  const transcript = transResponse.text?.trim() ?? '';

  let detectedName = params.incomingName || 'לא ידוע';
  let detectedRole = params.lastRole     || 'לא ידוע';
  let summary      = 'לא התקבל מידע ברור מהשיחה.';
  let tasks: TaskInput[] = [];

  if (transcript && transcript.length >= 5) {
    // Step 2 – Summarize + identify + extract tasks
    const sumResponse = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        parts: [{
          text: `Transcript:\n${transcript}\n\nNote: The user previously identified this number as "${params.incomingName}" with role "${params.lastRole || 'לא ידוע'}". Use this if the transcript doesn't provide a better name.`,
        }],
      }],
      config: {
        systemInstruction: SUMMARY_INSTR,
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    });

    try {
      const result = JSON.parse(sumResponse.text || '{}');
      detectedName = result.name !== 'לא ידוע' ? result.name : (params.incomingName || 'לא ידוע');
      detectedRole = result.role !== 'לא ידוע' ? result.role : (params.lastRole     || 'לא ידוע');
      summary      = result.summary || 'לא ניתן היה ליצור סיכום.';
      if (Array.isArray(result.tasks)) {
        tasks = result.tasks
          .filter((t: any) => t && typeof t.text === 'string' && t.text.length > 0)
          .map((t: any) => ({
            text: t.text as string,
            due_category: (['today', 'tomorrow', 'this_week', 'no_deadline'] as const).includes(t.due_category)
              ? t.due_category as TaskInput['due_category']
              : 'no_deadline' as const,
          }));
      }
    } catch {
      summary = sumResponse.text || 'שגיאה בפענוח הסיכום.';
    }
  }

  return {
    transcript: transcript || 'אין תמלול זמין',
    name:  detectedName,
    role:  detectedRole,
    summary,
    tasks,
  };
}

/**
 * Ask Gemini a freeform question about the user's call history.
 * Returns a Hebrew-language answer string.
 */
export async function askAIAboutCalls(
  question: string,
  transcripts: Array<{
    date: string;
    name: string;
    phone_number: string;
    summary: string;
    transcript: string;
    tasks: string[];
  }>
): Promise<string> {
  // ── Web mode: delegate to server ──────────────────────────────────────────
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/ai-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, transcripts }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }
    const data = await res.json();
    return data.answer || 'לא נמצא מידע רלוונטי.';
  }

  // ── Native mode: call Gemini directly ────────────────────────────────────
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('מפתח Gemini API לא מוגדר.');

  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey });

  const context = transcripts.length > 0
    ? transcripts.map((t, i) =>
        `[שיחה ${i + 1} — ${t.name} — ${t.phone_number} — ${t.date}]\nסיכום: ${t.summary}\nתמלול: ${t.transcript}\nמשימות ממני: ${t.tasks.join(' | ') || 'אין'}`
      ).join('\n\n---\n\n')
    : 'אין שיחות זמינות.';

  const systemInstruction = `אתה עוזר אישי שעונה על שאלות לגבי היסטוריית שיחות הטלפון של המשתמש. ענה בעברית. ענה בצורה שיחתית וישירה, כמו עוזר AI רגיל. אל תשתמש בסימוני markdown כלל — ללא ##, **, *, --, רשימות עם מקפים, או כל עיצוב אחר. טקסט רגיל בלבד. אם נשאלת שאלה ספציפית — ענה רק עליה בדיוק, בלי להוסיף את כל הסיכום. אם התבקשת לסכם — תן סיכום מלא. כשמתייחס לשיחה ספציפית, ציין את שם האיש והתאריך בתוך הטקסט.`;

  const prompt = `להלן היסטוריית שיחות הטלפון של המשתמש:\n\n${context}\n\nשאלת המשתמש: ${question}`;

  const response = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ parts: [{ text: prompt }] }],
    config: { systemInstruction, temperature: 0.3 },
  });

  return response.text?.trim() || 'לא נמצא מידע רלוונטי.';
}

// ─── Detailed re-summarization ────────────────────────────────────────────────

const DETAILED_SUMMARY_INSTR = `ענה בעברית. בהינתן התמלול הבא של שיחה, צור סיכום מפורט ומלא בטקסט רגיל בלבד — ללא ##, **, *, רשימות עם מקפים, או כל סימוני markdown אחרים. כתוב פסקאות רגילות וזורמות. כלול את כל הנושאים שנדונו, מספרים/תאריכים/סכומים שצוינו, התחייבויות שנלקחו על ידי כל צד, שאלות שנשאלו ותשובות שניתנו, ומסקנות. הסיכום צריך להיות מפורט ומלא ככל שניתן. לא לקצר.`;

export async function resummarizeCall(transcript: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/resummarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Server error');
    const data = await res.json();
    return data.summary || 'לא ניתן ליצור סיכום.';
  }

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('מפתח Gemini API לא מוגדר.');
  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey });
  const response = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ parts: [{ text: `תמלול השיחה:\n\n${transcript}` }] }],
    config: { systemInstruction: DETAILED_SUMMARY_INSTR, temperature: 0.3 },
  });
  return response.text?.trim() || 'לא ניתן ליצור סיכום.';
}

// ─── Ask about a specific call (with optional fresh audio) ────────────────────

export async function askAboutSpecificCall(params: {
  question: string;
  call: Call;
  audioBase64?: string;
  mimeType?: string;
}): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const res = await fetch('/api/ask-about-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question:    params.question,
        call:        params.call,
        audioBase64: params.audioBase64,
        mimeType:    params.mimeType,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Server error');
    const data = await res.json();
    return data.answer || 'לא נמצאה תשובה.';
  }

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('מפתח Gemini API לא מוגדר.');
  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey });

  const systemInstruction = `אתה עוזר אישי שעונה על שאלות לגבי שיחת טלפון ספציפית. ענה בעברית. ענה בצורה שיחתית וישירה, כמו עוזר AI רגיל. אל תשתמש בסימוני markdown כלל — ללא ##, **, *, --, או כל עיצוב אחר. טקסט רגיל בלבד. ענה רק על מה שנשאל — אל תספר את כל הסיכום אם לא התבקשת. כלול מספרים, תאריכים, ציטוטים מדויקים רק כשרלוונטי לשאלה.`;

  let parts: any[];
  if (params.audioBase64 && params.mimeType) {
    parts = [
      { text: `השאלה: ${params.question}\n\nענה על השאלה על סמך ההקלטה הבאה:` },
      { inlineData: { data: params.audioBase64, mimeType: params.mimeType } },
    ];
  } else {
    const fallbackNote = 'הקלטה לא נמצאה — מסתמך על תמלול שמור.';
    parts = [{ text: `${fallbackNote}\n\nתמלול השיחה:\n${params.call.transcript || 'אין תמלול'}\n\nשאלה: ${params.question}` }];
  }

  const response = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ parts }],
    config: { systemInstruction, temperature: 0.2 },
  });
  return response.text?.trim() || 'לא נמצאה תשובה.';
}

// ─── Identify which call a question refers to ─────────────────────────────────

interface ContextCall {
  id: number;
  date: string;
  name: string;
  phone_number: string;
  summary: string;
}

export async function identifyCallFromQuestion(
  question: string,
  calls: ContextCall[]
): Promise<number | null> {
  if (calls.length === 0) return null;

  const callList = calls.map(c =>
    `ID=${c.id}: ${c.name} (${c.phone_number}) ${c.date} — ${c.summary.slice(0, 100)}`
  ).join('\n');

  const prompt = `להלן רשימת שיחות טלפון:\n${callList}\n\nשאלת המשתמש: "${question}"\n\nאם השאלה עוסקת בשיחה ספציפית אחת מהרשימה, החזר את ה-ID שלה כמספר בלבד. אם השאלה כללית או עוסקת במספר שיחות, החזר null. ענה ב-JSON בלבד: {"id": <number or null>}`;

  // Both web and native use the same path since this is lightweight and needs no audio
  if (!Capacitor.isNativePlatform()) {
    // Use ai-search endpoint with a special identify query
    try {
      const res = await fetch('/api/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: prompt,
          transcripts: [],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = JSON.parse(data.answer || '{"id":null}');
      return typeof parsed.id === 'number' ? parsed.id : null;
    } catch { return null; }
  }

  const apiKey = await getApiKey();
  if (!apiKey) return null;
  const { GoogleGenAI } = await import('@google/genai');
  const genAI = new GoogleGenAI({ apiKey });
  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ parts: [{ text: prompt }] }],
      config: { temperature: 0, responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{"id":null}');
    return typeof parsed.id === 'number' ? parsed.id : null;
  } catch { return null; }
}
