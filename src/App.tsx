import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Phone, History, User, MessageSquare, PhoneIncoming, PhoneOutgoing, Mic, Settings, Eye, EyeOff, X, CheckSquare, Check, RotateCcw, ChevronDown, ChevronUp, Trash2, Share2 } from 'lucide-react';
import { Share } from '@capacitor/share';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { registerPlugin } from '@capacitor/core';
import {
  initDatabase, getRecentCalls, saveCall, saveTasks, getPendingTasks, markTaskDone,
  getCompletedTasks, markTaskUndone, deleteTask,
  getCallsByPhone, getCallerByPhone, getAllDistinctPhones, updateCallerNameByPhone,
  getCallById, updateCallSummary, deleteCall,
  type Call, type Task, type TaskInput
} from './services/database';
import { processCallAudio, askAIAboutCalls, resummarizeCall, askAboutSpecificCall, identifyCallFromQuestion } from './services/geminiClient';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ─── Capacitor plugin types ───────────────────────────────────────────────────

interface CallStateEvent {
  state: 'RINGING' | 'OFFHOOK' | 'IDLE';
  phoneNumber?: string;
  callAnsweredTimeMs?: number;
}

interface CallScreenedEvent {
  phoneNumber: string;
  direction: 'incoming' | 'outgoing';
}

interface CallDetectorPlugin {
  requestPermissions(): Promise<void>;
  requestOverlayPermission(): Promise<void>;
  requestCallScreeningRole(): Promise<void>;
  startCallDetection(): Promise<void>;
  stopCallDetection(): Promise<void>;
  getLatestRecording(options: { callStartTimeMs: number }): Promise<{ base64: string; mimeType: string }>;
  listRecentRecordings(options: { sinceMs: number }): Promise<{ recordings: Array<{ name: string; dateAddedMs: number; sizeBytes: number }> }>;
  getRecordingAt(options: { dateAddedMs: number }): Promise<{ base64: string; mimeType: string }>;
  getRecordingByTimeRange(options: { startMs: number; endMs: number }): Promise<{ base64: string; mimeType: string }>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  getPendingCallTime(): Promise<{ callAnsweredTimeMs: number }>;
  clearPendingCallTime(): Promise<void>;
  lookupContactName(options: { phone: string }): Promise<{ name?: string }>;
  getCallLogNumber(options: { dateMs: number }): Promise<{ phoneNumber: string }>;
  addListener(
    event: 'callStateChanged',
    handler: (data: CallStateEvent) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    event: 'callScreened',
    handler: (data: CallScreenedEvent) => void
  ): Promise<{ remove: () => void }>;
}

const CallDetector = registerPlugin<CallDetectorPlugin>('CallDetector');

interface RecordingWatcherPlugin {
  requestPermissions(): Promise<void>;
  startWatcher(): Promise<void>;
  stopWatcher(): Promise<void>;
  addListener(
    event: 'recordingReady',
    handler: (data: { base64: string; mimeType: string; phoneNumber: string; fileName: string }) => void
  ): Promise<{ remove: () => void }>;
}
const RecordingWatcher = registerPlugin<RecordingWatcherPlugin>('RecordingWatcher');

const NotificationScheduler = registerPlugin<{
  scheduleNotification(o: { id: number; title: string; body: string; triggerAtMs: number }): Promise<void>;
  cancelNotification(o: { id: number }): Promise<void>;
}>('NotificationScheduler');

// ─── Module-level helpers ─────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972') && digits.length >= 11) return '0' + digits.slice(3);
  return digits;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // Core state
  const [callHistory, setCallHistory]       = useState<Call[]>([]);
  const [selectedCall, setSelectedCall]     = useState<Call | null>(null);
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [viewingCall, setViewingCall]       = useState<Call | null>(null);
  const [incomingNumber, setIncomingNumber] = useState('');
  const [incomingName, setIncomingName]     = useState('');
  const [isProcessing, setIsProcessing]     = useState(false);
  const [statusMessage, setStatusMessage]   = useState('');
  const [showSettings, setShowSettings]     = useState(false);
  const [apiKeyInput, setApiKeyInput]       = useState('');
  const [showApiKey, setShowApiKey]         = useState(false);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [volume, setVolume]           = useState(0);

  // CRM state
  const [activeTab, setActiveTab]         = useState<'calls' | 'tasks' | 'search'>('calls');
  const [taskSubTab, setTaskSubTab]       = useState<'todo' | 'done'>('todo');
  const [tasks, setTasks]                 = useState<Task[]>([]);
  const [doneTasks, setDoneTasks]         = useState<Task[]>([]);
  const [searchQuery, setSearchQuery]     = useState('');
  const [isAiSearching, setIsAiSearching] = useState(false);
  const [chatMessages, setChatMessages]   = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [contactView, setContactView]     = useState<{ phone: string; name: string } | null>(null);
  const [contactCalls, setContactCalls]   = useState<Call[]>([]);
  const [shareMode, setShareMode]         = useState(false);
  const [selectedCallIds, setSelectedCallIds] = useState<Set<number>>(new Set());
  const [incomingCallHistory, setIncomingCallHistory] = useState<Call[]>([]);
  const [expandedTaskId, setExpandedTaskId]     = useState<number | null>(null);
  const [expandedContactKey, setExpandedContactKey] = useState<string | null>(null);
  const [resummarizingId, setResummarizingId] = useState<number | null>(null);

  // Refs — stable across renders, safe to use inside callbacks
  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const audioChunksRef      = useRef<Blob[]>([]);
  const animationFrameRef   = useRef<number | null>(null);
  const audioContextRef     = useRef<AudioContext | null>(null);
  const analyserRef         = useRef<AnalyserNode | null>(null);
  const callHistoryRef      = useRef<Call[]>([]);
  const incomingNameRef     = useRef('');
  const incomingNumberRef   = useRef('');
  const selectedCallRef     = useRef<Call | null>(null);
  const prevCallStateRef    = useRef<'IDLE' | 'RINGING' | 'OFFHOOK'>('IDLE');
  const startTimeRef        = useRef<number>(0);
  const callStartTimeMsRef  = useRef<number>(0);
  const recordingListenerRef = useRef<{ remove: () => void } | null>(null);
  const isProcessingRef     = useRef(false);
  const chatBottomRef       = useRef<HTMLDivElement | null>(null);
  const callDirectionRef    = useRef<'incoming' | 'outgoing'>('incoming');
  const contactNameRef      = useRef('');
  const lastContactSyncRef  = useRef(0);

  // Keep refs in sync with state
  useEffect(() => { callHistoryRef.current    = callHistory;    }, [callHistory]);
  useEffect(() => { incomingNameRef.current   = incomingName;   }, [incomingName]);
  useEffect(() => { incomingNumberRef.current = incomingNumber; }, [incomingNumber]);
  useEffect(() => { selectedCallRef.current   = selectedCall;   }, [selectedCall]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const loadCallHistory = async () => {
    try {
      const calls = await getRecentCalls();
      setCallHistory(calls);
      callHistoryRef.current = calls;
      // Silently enrich caller names from phone book (native only)
      if (Capacitor.isNativePlatform()) syncContactNamesSilent();
    } catch (err) {
      console.error('loadCallHistory error:', err);
      setCallHistory([]);
    }
  };

  const syncContactNamesSilent = async () => {
    if (!Capacitor.isNativePlatform()) return;
    // Throttle: at most once per 5 minutes
    const now = Date.now();
    if (now - lastContactSyncRef.current < 5 * 60 * 1000) return;
    lastContactSyncRef.current = now;
    try {
      const phones = await getAllDistinctPhones();
      for (const phone of phones) {
        const contactName = await lookupContactName(phone);
        if (contactName) await updateCallerNameByPhone(phone, contactName);
      }
      // Refresh displayed list with updated names (no status message)
      const calls = await getRecentCalls();
      setCallHistory(calls);
      callHistoryRef.current = calls;
    } catch { /* silent */ }
  };

  const loadTasks = async () => {
    try {
      const t = await getPendingTasks();
      setTasks(t);
    } catch (err) {
      console.error('loadTasks error:', err);
    }
  };

  const loadDoneTasks = async () => {
    try { setDoneTasks(await getCompletedTasks()); }
    catch (err) { console.error('loadDoneTasks error:', err); }
  };

  // Group calls by normalized phone number only — never group by AI name to prevent mixing
  const groupedCalls = useMemo(() => {
    const map = new Map<string, Call[]>();
    for (const call of callHistory) {
      let key: string;
      if (call.phone_number) {
        key = normalizePhone(call.phone_number);
      } else {
        // No phone number — keep each call isolated to prevent cross-person mixing
        key = `__noPhone_${call.id}`;
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(call);
    }
    // Explicit sort: newest group first (by most recent call in each group)
    return Array.from(map.values())
      .sort((a, b) => new Date(b[0].created_at).getTime() - new Date(a[0].created_at).getTime());
  }, [callHistory]);

  const openContactView = (phone: string, name: string) => {
    let filtered: Call[];
    if (phone) {
      const normPhone = normalizePhone(phone);
      filtered = callHistoryRef.current.filter(
        c => c.phone_number && normalizePhone(c.phone_number) === normPhone
      );
    } else {
      // No phone number — show only this specific call (don't group by name)
      filtered = callHistoryRef.current.filter(c => c.caller_name === name && !c.phone_number).slice(0, 1);
    }
    setContactCalls(filtered);
    setContactView({ phone, name });
    setShareMode(false);
    setSelectedCallIds(new Set());
  };

  const toggleShareCallId = (id: number) => {
    setSelectedCallIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const shareSelectedCalls = async () => {
    if (!contactView || selectedCallIds.size === 0) return;
    const selected = contactCalls
      .filter(c => selectedCallIds.has(c.id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const header = `שיחות עם ${contactView.name}${contactView.phone ? ` (${contactView.phone})` : ''}`;
    const divider = '──────────────────';
    const body = selected.map(c => {
      const { date, time } = formatDateTime(c.created_at);
      return `${date} ${time}:\n${c.summary}`;
    }).join('\n\n');
    const text = `${header}\n${divider}\n\n${body}`;

    try {
      if (Capacitor.isNativePlatform()) {
        await Share.share({ text, dialogTitle: 'שיתוף סיכומי שיחות' });
      } else if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        setStatusMessage('הועתק ללוח');
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch { /* user cancelled share dialog */ }
    setShareMode(false);
    setSelectedCallIds(new Set());
  };

  // ── Native call-state handler ──────────────────────────────────────────────

  const handleCallStateChange = async (data: CallStateEvent) => {
    const prev = prevCallStateRef.current;
    const next = data.state;
    console.log(`[TrueSummary] callStateChanged: ${prev} → ${next}, callAnsweredTimeMs=${data.callAnsweredTimeMs ?? 0}, native=${Capacitor.isNativePlatform()}`);
    if (next === prev) return;
    prevCallStateRef.current = next;

    if (next === 'RINGING' && prev === 'IDLE') {
      // Always reset for new call (even if callScreened already fired — re-lookup is harmless)
      setIncomingName('');
      setIncomingNumber('');
      setSelectedCall(null);
      incomingNameRef.current  = '';
      incomingNumberRef.current = '';
      selectedCallRef.current  = null;
      contactNameRef.current   = '';

      setIsIncomingCall(true);
      setStatusMessage('שיחה נכנסת...');
      const phone = data.phoneNumber || '';
      if (phone) {
        const norm = normalizePhone(phone);
        let lastCall: Call | null = callHistoryRef.current.find(
          c => normalizePhone(c.phone_number) === norm
        ) ?? null;
        if (!lastCall) {
          try { lastCall = await getCallerByPhone(phone) ?? null; } catch { /* ignore */ }
        }
        if (lastCall) {
          setSelectedCall(lastCall);
          selectedCallRef.current = lastCall;
        }
        // Contact name takes priority over DB name
        const contactName = await lookupContactName(phone);
        if (contactName) {
          contactNameRef.current  = contactName;
          incomingNameRef.current = contactName;
          setIncomingName(contactName);
        } else if (lastCall) {
          incomingNameRef.current = lastCall.caller_name;
          setIncomingName(lastCall.caller_name);
        }
        setIncomingNumber(phone);
        incomingNumberRef.current = phone;

        // Fetch call history for "שיחות קודמות" section (fire-and-forget)
        getCallsByPhone(phone)
          .then(hist => setIncomingCallHistory(hist.slice(0, 5)))
          .catch(() => {});
      }

    } else if (next === 'OFFHOOK' && prev === 'RINGING') {
      callDirectionRef.current = 'incoming';
      callStartTimeMsRef.current = data.callAnsweredTimeMs ?? Date.now();
      if (Capacitor.isNativePlatform()) {
        setStatusMessage('שיחה פעילה — Samsung מקליט...');
        RecordingWatcher.startWatcher()
          .then(() => console.log('[TrueSummary] RecordingWatcher.startWatcher() OK'))
          .catch(console.error);
        RecordingWatcher.addListener('recordingReady', async (data) => {
          console.log(`[TrueSummary] recordingReady: fileName=${data.fileName}, mimeType=${data.mimeType}, base64.length=${data.base64.length}`);
          setStatusMessage(`הקלטה נמצאה (${Math.round(data.base64.length / 1024)} KB) — מעבד...`);
          recordingListenerRef.current?.remove();
          recordingListenerRef.current = null;
          RecordingWatcher.stopWatcher().catch(console.error);
          await processCallAutomatically_fromBase64(data.base64, data.mimeType);
        }).then(listener => {
          recordingListenerRef.current = listener;
        }).catch(console.error);
      } else {
        startAutomatedRecording();
      }

    } else if (next === 'OFFHOOK' && prev === 'IDLE') {
      callDirectionRef.current = 'outgoing';
      setIsIncomingCall(true);
      if (!incomingNameRef.current) {
        setIncomingName('שיחה יוצאת');
        incomingNameRef.current = 'שיחה יוצאת';
      }
      callStartTimeMsRef.current = data.callAnsweredTimeMs ?? Date.now();
      if (Capacitor.isNativePlatform()) {
        setStatusMessage('שיחה יוצאת — Samsung מקליט...');
        RecordingWatcher.startWatcher()
          .then(() => console.log('[TrueSummary] RecordingWatcher.startWatcher() OK (outgoing)'))
          .catch(console.error);
        RecordingWatcher.addListener('recordingReady', async (data) => {
          console.log(`[TrueSummary] recordingReady (outgoing): fileName=${data.fileName}, mimeType=${data.mimeType}, base64.length=${data.base64.length}`);
          setStatusMessage(`הקלטה נמצאה (${Math.round(data.base64.length / 1024)} KB) — מעבד...`);
          recordingListenerRef.current?.remove();
          recordingListenerRef.current = null;
          RecordingWatcher.stopWatcher().catch(console.error);
          await processCallAutomatically_fromBase64(data.base64, data.mimeType);
        }).then(listener => {
          recordingListenerRef.current = listener;
        }).catch(console.error);
      } else {
        setStatusMessage('שיחה יוצאת...');
        startAutomatedRecording();
      }

    } else if (next === 'IDLE' && prev === 'OFFHOOK') {
      if (Capacitor.isNativePlatform()) {
        if (recordingListenerRef.current) {
          console.log('[TrueSummary] IDLE: watcher never fired — falling back to processSamsungRecording');
          recordingListenerRef.current.remove();
          recordingListenerRef.current = null;
          RecordingWatcher.stopWatcher().catch(console.error);
          processSamsungRecording();
        } else {
          console.log('[TrueSummary] IDLE: recordingReady already fired — pipeline in progress');
          RecordingWatcher.stopWatcher().catch(console.error);
        }
      } else {
        stopAutomatedRecording();
      }

    } else if (next === 'IDLE' && prev === 'RINGING') {
      setIsIncomingCall(false);
      setStatusMessage('');
      // Clear refs so next call's RINGING handler starts fresh
      incomingNumberRef.current = '';
      incomingNameRef.current   = '';
      selectedCallRef.current   = null;
      contactNameRef.current    = '';
    }
  };

  // ── CallScreeningService handler ───────────────────────────────────────────

  const handleCallScreened = async (data: CallScreenedEvent) => {
    // Reset stale state from previous call
    setIncomingCallHistory([]);

    setIncomingNumber(data.phoneNumber);
    incomingNumberRef.current = data.phoneNumber;

    // Switch UI to incoming call screen immediately
    if (data.direction === 'incoming') {
      setIsIncomingCall(true);
      setStatusMessage('שיחה נכנסת...');
    }

    // Look up contact name from phone book first
    const contactName = await lookupContactName(data.phoneNumber);
    if (contactName) {
      contactNameRef.current  = contactName;
      incomingNameRef.current = contactName;
      setIncomingName(contactName);
    }

    const norm = normalizePhone(data.phoneNumber);
    let lastCall = callHistoryRef.current.find(
      c => normalizePhone(c.phone_number) === norm
    );
    if (!lastCall) {
      // DB fallback — catches callers beyond the 50-call in-memory limit
      try {
        const dbCall = await getCallerByPhone(data.phoneNumber);
        if (dbCall) lastCall = dbCall;
      } catch { /* ignore */ }
    }

    if (lastCall) {
      // Only use DB name if contact lookup found nothing
      if (!contactName) {
        setIncomingName(lastCall.caller_name);
        incomingNameRef.current = lastCall.caller_name;
      }
      setSelectedCall(lastCall);
      selectedCallRef.current = lastCall;
    } else if (!contactName) {
      const name = data.direction === 'outgoing' ? 'שיחה יוצאת' : 'מתקשר לא מזוהה';
      setIncomingName(name);
      incomingNameRef.current = name;
      setSelectedCall(null);
      selectedCallRef.current = null;
    }

    // Fetch call history for "שיחות קודמות" section (fire-and-forget)
    getCallsByPhone(data.phoneNumber)
      .then(hist => setIncomingCallHistory(hist.slice(0, 5)))
      .catch(() => {});
  };

  // ── Init effect ────────────────────────────────────────────────────────────

  useEffect(() => {
    let l1: { remove: () => void } | null = null;
    let l2: { remove: () => void } | null = null;

    async function init() {
      try { await initDatabase(); } catch (err) { console.error('DB init:', err); }

      await Promise.all([loadCallHistory(), loadTasks(), loadDoneTasks()]);

      try {
        const { value } = await Preferences.get({ key: 'gemini_api_key' });
        if (value) setApiKeyInput(value);
      } catch { /* web mode */ }

      if (Capacitor.isNativePlatform()) {
        CallDetector.requestPermissions().catch(() => {});
        RecordingWatcher.requestPermissions().catch(() => {});
        // Request battery optimization exemption on first launch to keep CallService alive
        CallDetector.requestIgnoreBatteryOptimizations().catch(() => {});
        try {
          l1 = await CallDetector.addListener('callStateChanged', handleCallStateChange);
          l2 = await CallDetector.addListener('callScreened',     handleCallScreened);
          await CallDetector.startCallDetection();
        } catch (err) {
          console.error('CallDetector setup failed:', err);
        }

        await checkPendingCall();
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadCallHistory();
        loadTasks();
        loadDoneTasks();
        checkPendingCall();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    init();

    return () => {
      l1?.remove();
      l2?.remove();
      recordingListenerRef.current?.remove();
      RecordingWatcher.stopWatcher().catch(() => {});
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current)   audioContextRef.current.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll chat to bottom ─────────────────────────────────────────────

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Recording ──────────────────────────────────────────────────────────────

  const startAutomatedRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser     = audioContext.createAnalyser();
      const source       = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray    = new Uint8Array(bufferLength);

      audioContextRef.current = audioContext;
      analyserRef.current     = analyser;

      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        setVolume(sum / bufferLength);
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };
      updateVolume();

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current   = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        setVolume(0);
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        await processCallAutomatically(audioBlob, mimeType);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      startTimeRef.current = Date.now();
      setStatusMessage('שיחה בהקלטה אוטומטית...');

      if (!Capacitor.isNativePlatform()) {
        setTimeout(() => stopAutomatedRecording(), 15000);
      }
    } catch (err) {
      console.error('Microphone access error:', err);
      setStatusMessage('שגיאה: וודא הרשאות מיקרופון');
      setTimeout(() => setIsIncomingCall(false), 3000);
    }
  };

  const stopAutomatedRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // ── Samsung recording retrieval ────────────────────────────────────────────

  const processSamsungRecording = async () => {
    console.log(`[TrueSummary] processSamsungRecording: callStartTimeMs=${callStartTimeMsRef.current}`);
    setStatusMessage('ממתין לסיום ההקלטה (fallback MediaStore)...');
    await new Promise(r => setTimeout(r, 2500));
    try {
      setStatusMessage('מחפש הקלטה ב-MediaStore...');
      const { base64, mimeType } = await CallDetector.getLatestRecording({
        callStartTimeMs: callStartTimeMsRef.current,
      });
      console.log(`[TrueSummary] getLatestRecording returned: mimeType=${mimeType}, base64.length=${base64.length}`);
      await processCallAutomatically_fromBase64(base64, mimeType);
    } catch (err: any) {
      console.error('[TrueSummary] processSamsungRecording error:', err);
      setStatusMessage('לא נמצאה הקלטה — בדוק הרשאות Samsung');
      setTimeout(() => setIsIncomingCall(false), 4000);
    }
  };

  // ── Pending call recovery ──────────────────────────────────────────────────

  const checkPendingCall = async () => {
    if (!Capacitor.isNativePlatform()) return;
    if (isProcessingRef.current) return;
    try {
      const { callAnsweredTimeMs } = await CallDetector.getPendingCallTime();
      if (callAnsweredTimeMs > 0) {
        console.log(`[TrueSummary] checkPendingCall: found pending call at ${callAnsweredTimeMs}`);
        await CallDetector.clearPendingCallTime();
        callStartTimeMsRef.current = callAnsweredTimeMs;
        setIsIncomingCall(true);
        await processSamsungRecording();
      }
    } catch (err) {
      console.error('[TrueSummary] checkPendingCall error:', err);
    }
  };

  // ── Missed-call batch scanner ──────────────────────────────────────────────

  const scanMissedCalls = async () => {
    if (!Capacitor.isNativePlatform() || isProcessingRef.current) return;
    setStatusMessage('סורק שיחות שהוחמצו...');
    try {
      // Look back 7 days
      const sinceMs = Date.now() - 7 * 24 * 3600 * 1000;
      const { recordings: allRecordings } = await CallDetector.listRecentRecordings({ sinceMs });
      // Keep only the 20 most recent recordings
      const recordings = allRecordings
        .sort((a, b) => b.dateAddedMs - a.dateAddedMs)
        .slice(0, 20);

      // Check which recordings already have a DB entry (within ±90 s of dateAddedMs)
      // Query the full DB (not just in-memory list) for more accurate dedup
      let dbCalls = callHistoryRef.current;
      try {
        dbCalls = await getRecentCalls(200);
      } catch { /* fall back to in-memory */ }

      const unprocessed = recordings.filter(rec =>
        !dbCalls.some(call => {
          const dbTime = new Date(call.created_at).getTime();
          return Math.abs(dbTime - rec.dateAddedMs) < 90_000;
        })
      ).sort((a, b) => a.dateAddedMs - b.dateAddedMs); // oldest-first for processing

      if (unprocessed.length === 0) {
        setStatusMessage('אין שיחות שהוחמצו');
        setTimeout(() => setStatusMessage(''), 3000);
        return;
      }

      console.log(`[TrueSummary] scanMissedCalls: ${unprocessed.length} unprocessed recordings`);
      setStatusMessage(`מעבד ${unprocessed.length} שיחות שהוחמצו...`);

      // Process oldest-first, one at a time
      for (const rec of unprocessed) {
        // Reset call refs for each recording — prevents bleed-over from prior calls
        incomingNumberRef.current = '';
        incomingNameRef.current   = '';
        selectedCallRef.current   = null;
        contactNameRef.current    = '';

        // Extract phone number: try filename first, then Android Call Log fallback
        let extractedPhone = extractPhoneFromFilename(rec.name);
        if (!extractedPhone) {
          try {
            const { phoneNumber } = await CallDetector.getCallLogNumber({ dateMs: rec.dateAddedMs });
            if (phoneNumber) extractedPhone = normalizePhone(phoneNumber);
          } catch { /* permission not granted or no match */ }
        }
        if (extractedPhone) {
          incomingNumberRef.current = extractedPhone;
          const norm = normalizePhone(extractedPhone);
          const existing = callHistoryRef.current.find(
            c => c.phone_number && normalizePhone(c.phone_number) === norm
          );
          if (existing) {
            incomingNameRef.current = existing.caller_name;
            selectedCallRef.current = existing;
          }
        }

        // Contact name takes priority over AI-detected name
        if (incomingNumberRef.current) {
          const contactName = await lookupContactName(incomingNumberRef.current);
          if (contactName) {
            contactNameRef.current  = contactName;
            incomingNameRef.current = contactName;
          }
        }

        const label = rec.name.replace(/^Call recording\s*/i, '').replace(/_\d{6}_\d{6}\..*$/, '');
        setStatusMessage(`מעבד: ${label}...`);
        callStartTimeMsRef.current = rec.dateAddedMs; // so saveCall stores correct recording time
        try {
          const { base64, mimeType } = await CallDetector.getRecordingAt({ dateAddedMs: rec.dateAddedMs });
          callDirectionRef.current = 'incoming'; // treat missed calls as incoming
          await processCallAutomatically_fromBase64(base64, mimeType);
        } catch (e: any) {
          console.error('[TrueSummary] scanMissedCalls: failed', rec.name, e?.message);
        }
        // Reset processing flag immediately so the next iteration isn't blocked
        // (processCallAutomatically_fromBase64 delays reset by 3s via setTimeout)
        isProcessingRef.current = false;
        await loadCallHistory(); // refresh list after each
      }

      setStatusMessage('סריקה הושלמה ✓');
      setTimeout(() => setStatusMessage(''), 4000);
    } catch (err) {
      console.error('[TrueSummary] scanMissedCalls error:', err);
      setStatusMessage('');
    }
  };

  // ── Contact-name sync ──────────────────────────────────────────────────────

  const syncContactNames = async () => {
    if (!Capacitor.isNativePlatform()) return;
    setStatusMessage('מסנכרן שמות מאנשי קשר...');
    try {
      const phones = await getAllDistinctPhones();
      if (phones.length === 0) {
        setStatusMessage('אין שיחות עם מספר טלפון');
        setTimeout(() => setStatusMessage(''), 3000);
        return;
      }
      let updated = 0;
      for (const phone of phones) {
        const contactName = await lookupContactName(phone);
        if (contactName) {
          await updateCallerNameByPhone(phone, contactName);
          updated++;
        }
      }
      setStatusMessage(`עודכן ${updated} מתוך ${phones.length} אנשי קשר ✓`);
      setTimeout(() => setStatusMessage(''), 4000);
      await loadCallHistory();
    } catch (err) {
      console.error('[TrueSummary] syncContactNames error:', err);
      setStatusMessage('');
    }
  };

  // ── AI processing + save ───────────────────────────────────────────────────

  const processCallAutomatically_fromBase64 = async (base64: string, mimeType: string) => {
    if (isProcessingRef.current) {
      console.log('[TrueSummary] processCallAutomatically_fromBase64: already processing, skipping duplicate');
      return;
    }
    isProcessingRef.current = true;
    console.log(`[TrueSummary] processCallAutomatically_fromBase64: mimeType=${mimeType}, base64.length=${base64.length}`);
    setIsProcessing(true);
    setStatusMessage('שולח לעיבוד Gemini...');

    // Capture ALL refs into locals at entry to prevent race conditions
    // (a new incoming call could overwrite refs while we're processing)
    let number          = incomingNumberRef.current;
    const name          = incomingNameRef.current;
    const lastCall      = selectedCallRef.current;
    const recordingTs   = callStartTimeMsRef.current;
    const duration      = Math.round((Date.now() - recordingTs) / 1000);
    let capturedContact = contactNameRef.current;
    const capturedDir   = callDirectionRef.current;

    try {
      // Fallback: if phone number is missing, query Android Call Log
      if (!number && Capacitor.isNativePlatform() && recordingTs > 0) {
        try {
          const { phoneNumber } = await CallDetector.getCallLogNumber({ dateMs: recordingTs });
          if (phoneNumber) {
            number = normalizePhone(phoneNumber);
          }
        } catch { /* ignore */ }
      }

      setStatusMessage('מתמלל ומסכם שיחה עם Gemini...');

      const { transcript, name: detectedName, role: detectedRole, summary, tasks: rawTasks } =
        await processCallAudio({
          audioBase64:  base64,
          mimeType,
          incomingName: name,
          lastRole:     lastCall?.caller_role || 'לא ידוע',
        });

      console.log(`[TrueSummary] processCallAudio done: transcript.length=${transcript.length}, name=${detectedName}, role=${detectedRole}, tasks=${rawTasks.length}`);
      setStatusMessage('שומר שיחה...');

      // Fallback: if contact name wasn't resolved yet (race condition), try now
      if (!capturedContact && number) {
        const cn = await lookupContactName(number);
        if (cn) capturedContact = cn;
      }

      const { id: callId } = await saveCall({
        phone_number:          number,
        caller_name:           capturedContact || detectedName,
        caller_role:           detectedRole,
        summary,
        transcript,
        duration,
        call_type:             capturedDir,
        recordingTimestampMs:  recordingTs,
      });

      console.log(`[TrueSummary] saveCall done: phone_number=${number}, name=${detectedName}, callId=${callId}`);

      // Retroactively update older calls with the same number to use the contact name
      if (capturedContact && number) {
        updateCallerNameByPhone(number, capturedContact).catch(() => {});
      }

      // Save tasks and schedule notifications
      if (rawTasks.length > 0) {
        try {
          const savedTasks = await saveTasks(callId, number, detectedName, rawTasks);
          for (const t of savedTasks) {
            if (t.due_ts && t.due_ts > Date.now()) {
              NotificationScheduler.scheduleNotification({
                id: t.id,
                title: 'TrueSummary – תזכורת',
                body: t.text,
                triggerAtMs: t.due_ts,
              }).catch(console.error);
            }
          }
        } catch (err) {
          console.error('[TrueSummary] saveTasks error:', err);
        }
      }

      setStatusMessage('השיחה סוכמה ונשמרה ✓');
      setTimeout(async () => {
        isProcessingRef.current    = false;
        callDirectionRef.current   = 'incoming';
        setIsIncomingCall(false);
        setIsProcessing(false);
        setStatusMessage('');
        setIncomingNumber('');
        setIncomingName('');
        setSelectedCall(null);
        setIncomingCallHistory([]);
        incomingNumberRef.current  = '';
        incomingNameRef.current    = '';
        selectedCallRef.current    = null;
        prevCallStateRef.current   = 'IDLE';
        callStartTimeMsRef.current = 0;
        await Promise.all([loadCallHistory(), loadTasks(), loadDoneTasks()]);
      }, 3000);
    } catch (err: any) {
      console.error(err);
      setStatusMessage(`שגיאה: ${err.message || 'עיבוד נכשל'}`);
      setTimeout(() => {
        isProcessingRef.current  = false;
        callDirectionRef.current = 'incoming';
        setIsIncomingCall(false);
        setIsProcessing(false);
      }, 4000);
    }
  };

  const processCallAutomatically = async (blob: Blob, mimeType: string) => {
    if (isProcessingRef.current) {
      console.log('[TrueSummary] processCallAutomatically: already processing, skipping duplicate');
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);
    setStatusMessage('מעבד נתונים ומסכם...');

    // Capture ALL refs into locals at entry to prevent race conditions
    const number          = incomingNumberRef.current;
    const name            = incomingNameRef.current;
    const lastCall        = selectedCallRef.current;
    const duration        = Math.round((Date.now() - startTimeRef.current) / 1000);
    const capturedContact = contactNameRef.current;
    const capturedDir     = callDirectionRef.current;
    const capturedStartTs = startTimeRef.current;

    try {
      const base64data: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror   = reject;
      });

      setStatusMessage('מתמלל ומסכם שיחה...');

      const { transcript, name: detectedName, role: detectedRole, summary, tasks: rawTasks } =
        await processCallAudio({
          audioBase64:  base64data,
          mimeType,
          incomingName: name,
          lastRole:     lastCall?.caller_role || 'לא ידוע',
        });

      const { id: callId } = await saveCall({
        phone_number:         number,
        caller_name:          capturedContact || detectedName,
        caller_role:          detectedRole,
        summary,
        transcript,
        duration,
        call_type:            capturedDir,
        recordingTimestampMs: capturedStartTs,
      });

      if (rawTasks.length > 0) {
        try {
          const savedTasks = await saveTasks(callId, number, detectedName, rawTasks);
          for (const t of savedTasks) {
            if (t.due_ts && t.due_ts > Date.now()) {
              NotificationScheduler.scheduleNotification({
                id: t.id,
                title: 'TrueSummary – תזכורת',
                body: t.text,
                triggerAtMs: t.due_ts,
              }).catch(console.error);
            }
          }
        } catch (err) {
          console.error('[TrueSummary] saveTasks error:', err);
        }
      }

      setStatusMessage('השיחה סוכמה ונשמרה');
      setTimeout(async () => {
        isProcessingRef.current    = false;
        callDirectionRef.current   = 'incoming';
        setIsIncomingCall(false);
        setIsProcessing(false);
        setIncomingNumber('');
        setIncomingName('');
        setSelectedCall(null);
        setIncomingCallHistory([]);
        incomingNumberRef.current  = '';
        incomingNameRef.current    = '';
        selectedCallRef.current    = null;
        prevCallStateRef.current   = 'IDLE';
        contactNameRef.current     = '';
        await Promise.all([loadCallHistory(), loadTasks(), loadDoneTasks()]);
      }, 3000);
    } catch (err: any) {
      console.error(err);
      setStatusMessage(`שגיאה: ${err.message || 'עיבוד נכשל'}`);
      setTimeout(() => {
        isProcessingRef.current  = false;
        callDirectionRef.current = 'incoming';
        setIsIncomingCall(false);
        setIsProcessing(false);
      }, 4000);
    }
  };

  // ── Simulation (web / demo) ────────────────────────────────────────────────

  const simulateIncomingCall = (call?: Call) => {
    let number = '052-4455667';
    let name   = 'לקוח פוטנציאלי';

    if (call) {
      number = call.phone_number;
      name   = call.caller_name;
    } else {
      const scenarios = [
        { n: '052-4455667', name: 'לקוח פוטנציאלי' },
        { n: '050-1234567', name: 'לקוח פוטנציאלי' },
        { n: '054-9876543', name: 'ספק' },
        { n: '053-1112223', name: 'לא ידוע' },
      ];
      const pick    = scenarios[Math.floor(Math.random() * scenarios.length)];
      number        = pick.n;
      const normN   = normalizePhone(number);
      const history = callHistoryRef.current.find(c => normalizePhone(c.phone_number) === normN);
      name          = history ? history.caller_name : pick.name;
    }

    const normNum  = normalizePhone(number);
    const lastCall = call || callHistoryRef.current.find(c => normalizePhone(c.phone_number) === normNum) || null;
    callDirectionRef.current  = 'incoming';
    setIncomingNumber(number);
    setIncomingName(name);
    setSelectedCall(lastCall);
    incomingNumberRef.current = number;
    incomingNameRef.current   = name;
    selectedCallRef.current   = lastCall;
    setIsIncomingCall(true);
    startAutomatedRecording();
  };

  // ── AI Chat ────────────────────────────────────────────────────────────────

  const handleResummarize = async (call: Call) => {
    if (!call.transcript || resummarizingId !== null) return;
    setResummarizingId(call.id);
    try {
      const newSummary = await resummarizeCall(call.transcript);
      await updateCallSummary(call.id, newSummary);
      await loadCallHistory();
      // Refresh the contact modal without closing it
      setContactCalls(prev => prev.map(c => c.id === call.id ? { ...c, summary: newSummary } : c));
    } catch (err) {
      console.error('handleResummarize error:', err);
    } finally {
      setResummarizingId(null);
    }
  };

  const handleDeleteCall = async (callId: number) => {
    try {
      await deleteCall(callId);
      setContactCalls(prev => {
        const remaining = prev.filter(c => c.id !== callId);
        // Auto-close contact modal when last call is deleted
        if (remaining.length === 0) setContactView(null);
        return remaining;
      });
      await Promise.all([loadCallHistory(), loadTasks(), loadDoneTasks()]);
    } catch (err) {
      console.error('handleDeleteCall error:', err);
    }
  };

  const sendChatMessage = async () => {
    const msg = searchQuery.trim();
    if (!msg || isAiSearching) return;

    const userMessage = { role: 'user' as const, text: msg };
    setChatMessages(prev => [...prev, userMessage]);
    setSearchQuery('');
    setIsAiSearching(true);

    const ctx = callHistory.map(c => ({
      id:           c.id,
      date:         c.created_at,
      name:         c.caller_name,
      phone_number: c.phone_number,
      summary:      c.summary,
      transcript:   c.transcript,
      tasks:        tasks.filter(t => t.call_id === c.id).map(t => t.text),
    }));

    try {
      // Step 1: Try to identify if the question is about a specific call
      let deepCallId: number | null = null;
      try {
        deepCallId = await identifyCallFromQuestion(msg, ctx);
      } catch { /* fall through */ }

      if (deepCallId !== null) {
        // Step 2a: Deep analysis mode — find the call and optionally its recording
        const targetCall = callHistory.find(c => c.id === deepCallId)
          ?? await getCallById(deepCallId).catch(() => null);

        if (targetCall) {
          setChatMessages(prev => [...prev, { role: 'assistant', text: 'מחפש הקלטה...' }]);

          let audioBase64: string | undefined;
          let mimeType: string | undefined;
          if (Capacitor.isNativePlatform() && targetCall.recording_timestamp_ms) {
            try {
              const rec = await CallDetector.getRecordingByTimeRange({
                startMs: targetCall.recording_timestamp_ms,
                endMs:   targetCall.recording_timestamp_ms + targetCall.duration * 1000 + 120_000,
              });
              audioBase64 = rec.base64;
              mimeType    = rec.mimeType;
            } catch { /* recording not found — fall back to transcript */ }
          }

          const answer = await askAboutSpecificCall({ question: msg, call: targetCall, audioBase64, mimeType });
          // Replace the placeholder message
          setChatMessages(prev => [...prev.slice(0, -1), { role: 'assistant', text: answer }]);
          setIsAiSearching(false);
          return;
        }
      }

      // Step 2b: General mode — existing behavior
      const answer = await askAIAboutCalls(msg, ctx);
      setChatMessages(prev => [...prev, { role: 'assistant', text: answer }]);
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: `שגיאה: ${err.message}` }]);
    } finally {
      setIsAiSearching(false);
    }
  };

  // ── Settings ───────────────────────────────────────────────────────────────

  const saveApiKey = async () => {
    try {
      await Preferences.set({ key: 'gemini_api_key', value: apiKeyInput });
    } catch { /* web mode */ }
    setStatusMessage('מפתח API נשמר');
    setTimeout(() => {
      setStatusMessage('');
      setShowSettings(false);
    }, 800);
  };

  // ── Task actions ───────────────────────────────────────────────────────────

  const handleMarkTaskDone = async (task: Task) => {
    try {
      await markTaskDone(task.id);
      NotificationScheduler.cancelNotification({ id: task.id }).catch(() => {});
      await Promise.all([loadTasks(), loadDoneTasks()]);
    } catch (err) {
      console.error('markTaskDone error:', err);
    }
  };

  const handleDeleteTask = async (task: Task) => {
    try {
      await deleteTask(task.id);
      NotificationScheduler.cancelNotification({ id: task.id }).catch(() => {});
      await Promise.all([loadTasks(), loadDoneTasks()]);
    } catch (err) {
      console.error('handleDeleteTask error:', err);
    }
  };

  const handleRestoreTask = async (task: Task) => {
    try {
      await markTaskUndone(task.id);
      await Promise.all([loadTasks(), loadDoneTasks()]);
    } catch (err) {
      console.error('handleRestoreTask error:', err);
    }
  };

  // ── Formatting helpers ─────────────────────────────────────────────────────

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDateTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return {
      date: date.toLocaleDateString('he-IL'),
      time: date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
    };
  };

  const lookupContactName = async (phone: string): Promise<string> => {
    if (!Capacitor.isNativePlatform() || !phone) return '';
    try {
      const result = await CallDetector.lookupContactName({ phone });
      return result.name ?? '';
    } catch { return ''; }
  };

  const extractPhoneFromFilename = (name: string): string => {
    // Samsung names recordings like: +972501234567_20230101_120000.m4a
    // or: Call recording_0501234567_20230101_120000.m4a
    const intlMatch = name.match(/(\+?972\d{8,9})/);
    if (intlMatch) {
      const digits = intlMatch[1].replace(/\D/g, '');
      return digits.startsWith('972') ? '0' + digits.slice(3) : digits;
    }
    // Israeli local: 05X followed by 7 more digits (10 digits total)
    const localMatch = name.match(/(05\d{8})/);
    if (localMatch) return localMatch[1];
    return '';
  };

  const dueBadge = (cat: Task['due_category']) => {
    switch (cat) {
      case 'today':     return { label: 'היום',   cls: 'bg-orange-500/20 text-orange-400' };
      case 'tomorrow':  return { label: 'מחר',    cls: 'bg-blue-500/20 text-blue-400' };
      case 'this_week': return { label: 'השבוע',  cls: 'bg-purple-500/20 text-purple-400' };
      default:          return { label: 'ללא מועד', cls: 'bg-gray-500/20 text-gray-400' };
    }
  };

  const renderHighlightedSummary = (summary: string, taskText: string) => {
    const sentences = summary.split(/\.(?:\s|\n)/g).filter(s => s.trim().length > 0);
    const keywords = taskText.split(/\s+/).filter(w => w.length > 2);
    return (
      <p className="text-sm leading-relaxed">
        {sentences.map((sentence, i) => {
          const isRelevant = keywords.some(kw =>
            sentence.toLowerCase().includes(kw.toLowerCase())
          );
          return (
            <span key={i}>
              <span className={isRelevant
                ? 'bg-amber-500/15 text-amber-200 rounded px-1'
                : 'text-gray-400'
              }>
                {sentence.trim()}
              </span>
              {i < sentences.length - 1 ? '. ' : ''}
            </span>
          );
        })}
      </p>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-[#F5F5F7] font-sans selection:bg-blue-500/30" dir="rtl">
      {!isIncomingCall ? (
        /* ── Dashboard ────────────────────────────────────────────────── */
        <div className="max-w-md mx-auto min-h-screen flex flex-col p-6 space-y-6">
          {/* Header */}
          <header className="pt-16 pb-4 flex items-center gap-5">
            <button
              onClick={() => setShowSettings(true)}
              className="w-12 h-12 bg-[#1C1C1E] rounded-2xl flex items-center justify-center text-gray-500 hover:text-white hover:bg-[#2C2C2E] transition-all border border-white/5"
              title="הגדרות"
            >
              <Settings size={22} />
            </button>
            <div className="w-16 h-16 bg-[#1C1C1E] rounded-3xl flex items-center justify-center shadow-2xl border border-white/5">
              <Phone size={32} className="text-blue-500" fill="currentColor" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white">TrueSummary</h1>
              <div className="flex items-center gap-2 mt-1">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <p className="text-[11px] text-gray-500 font-bold uppercase tracking-[0.2em]">מערכת פעילה</p>
              </div>
            </div>
          </header>

          {/* No API key banner */}
          {!apiKeyInput && Capacitor.isNativePlatform() && (
            <button
              onClick={() => setShowSettings(true)}
              className="w-full bg-amber-600/20 border border-amber-500/30 rounded-2xl px-4 py-3 flex items-center gap-3 text-right"
            >
              <div className="w-8 h-8 bg-amber-500/20 rounded-xl flex items-center justify-center flex-shrink-0">
                <Settings size={16} className="text-amber-400" />
              </div>
              <div className="flex-1">
                <p className="text-amber-300 text-sm font-bold">מפתח API לא מוגדר</p>
                <p className="text-amber-400/60 text-xs">לחץ כאן להגדרת מפתח Gemini API</p>
              </div>
            </button>
          )}

          {/* Tab bar */}
          <div className="flex bg-[#1C1C1E] rounded-2xl p-1 gap-1 border border-white/5">
            <button
              onClick={() => setActiveTab('calls')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all',
                activeTab === 'calls' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-white'
              )}
            >
              <History size={16} />
              שיחות
            </button>
            <button
              onClick={() => setActiveTab('tasks')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all relative',
                activeTab === 'tasks' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-white'
              )}
            >
              <CheckSquare size={16} />
              משימות
              {tasks.length > 0 && (
                <span className="absolute top-1.5 left-1.5 bg-red-500 text-white text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                  {tasks.length > 9 ? '9+' : tasks.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('search')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all',
                activeTab === 'search' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-white'
              )}
            >
              <MessageSquare size={16} />
              AI Chat
            </button>
          </div>

          {/* ── Tab: Calls ─────────────────────────────────────────────── */}
          {activeTab === 'calls' && (
            <section className="flex-1 space-y-4">
              {Capacitor.isNativePlatform() && (
                <div className="flex gap-2">
                  <button
                    onClick={scanMissedCalls}
                    className="flex-1 flex items-center justify-center gap-2 py-3 bg-[#1C1C1E] rounded-2xl text-amber-400 hover:text-amber-300 hover:bg-[#2C2C2E] transition-all border border-white/5 text-sm font-bold"
                  >
                    <History size={16} />
                    סרוק שיחות שהוחמצו
                  </button>
                  <button
                    onClick={syncContactNames}
                    className="flex-1 flex items-center justify-center gap-2 py-3 bg-[#1C1C1E] rounded-2xl text-blue-400 hover:text-blue-300 hover:bg-[#2C2C2E] transition-all border border-white/5 text-sm font-bold"
                  >
                    <User size={16} />
                    סנכרן אנשי קשר
                  </button>
                </div>
              )}
              {/* Sync status indicator */}
              {statusMessage && (
                <div className="flex items-center justify-center gap-3 py-3 bg-[#1C1C1E] rounded-2xl border border-white/5">
                  <div className="flex gap-1">
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="w-1 h-4 bg-amber-500/60 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                  <span className="text-amber-400 text-sm font-bold">{statusMessage}</span>
                </div>
              )}
              <div className="grid gap-5">
                {groupedCalls.length > 0 ? (
                  groupedCalls.map((group) => {
                    const latest = group[0];
                    const key = latest.phone_number
                      ? normalizePhone(latest.phone_number)
                      : (latest.caller_name && latest.caller_name !== 'לא ידוע')
                        ? `__name_${latest.caller_name}`
                        : `__noPhone_${latest.id}`;
                    const isExpanded = expandedContactKey === key;
                    const { date, time } = formatDateTime(latest.created_at);
                    return (
                      <div
                        key={key}
                        className="w-full bg-[#1C1C1E] rounded-[32px] shadow-2xl border border-white/[0.03] hover:border-blue-500/30 transition-all duration-500 overflow-hidden"
                      >
                        {/* ── Group header ── */}
                        <div className="p-6 flex items-center justify-between group">
                          <button
                            onClick={() => openContactView(latest.phone_number, latest.caller_name)}
                            className="flex-1 flex items-center gap-5 text-right"
                          >
                            <div className="w-14 h-14 bg-[#2C2C2E] rounded-2xl flex items-center justify-center text-gray-400 group-hover:bg-blue-600 group-hover:text-white transition-all duration-300 flex-shrink-0">
                              <User size={28} />
                            </div>
                            <div className="flex-1 min-w-0">
                              {/* Row 1: name + direction icon */}
                              <div className="flex items-center gap-2 mb-0.5">
                                {latest.call_type === 'outgoing'
                                  ? <PhoneOutgoing size={13} className="text-blue-400 flex-shrink-0" />
                                  : <PhoneIncoming size={13} className="text-green-400 flex-shrink-0" />
                                }
                                <span className="font-bold text-lg text-white truncate group-hover:text-blue-400 transition-colors">
                                  {latest.caller_name}
                                </span>
                              </div>

                              {/* Row 2: phone number */}
                              <p className="text-sm text-gray-500 font-mono mb-2">
                                {latest.phone_number || <span className="italic text-gray-600">מספר לא זוהה</span>}
                              </p>

                              {/* Row 3: summary preview */}
                              {latest.summary && (
                                <p className="text-sm text-gray-400 leading-relaxed line-clamp-2 mb-2">
                                  {latest.summary}
                                </p>
                              )}

                              {/* Row 4: date + duration + call count badge */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs text-gray-400 font-bold">{date} • {time}</span>
                                {latest.duration > 0 && (
                                  <span className="text-[10px] bg-white/5 text-gray-400 px-2 py-0.5 rounded-full font-bold">
                                    {formatDuration(latest.duration)}
                                  </span>
                                )}
                                {group.length > 1 && (
                                  <span className="text-[10px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full font-bold">
                                    {group.length} שיחות
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                          <div className="flex items-center gap-2">
                            {group.length > 1 && (
                              <button
                                onClick={() => setExpandedContactKey(prev => prev === key ? null : key)}
                                className="w-10 h-10 bg-[#2C2C2E] text-gray-400 rounded-xl flex items-center justify-center hover:bg-[#3C3C3E] hover:text-white transition-all"
                                title={isExpanded ? 'כווץ' : 'הרחב'}
                              >
                                {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); simulateIncomingCall(latest); }}
                              className="w-12 h-12 bg-blue-600/10 text-blue-500 rounded-2xl flex items-center justify-center hover:bg-blue-600 hover:text-white transition-all duration-300 shadow-lg"
                              title="דמה שיחה"
                            >
                              <PhoneIncoming size={22} />
                            </button>
                          </div>
                        </div>

                        {/* ── Expanded sub-rows ── */}
                        {isExpanded && (
                          <div className="border-t border-white/5 divide-y divide-white/[0.03]">
                            {group.map((call) => {
                              const { date: cDate, time: cTime } = formatDateTime(call.created_at);
                              return (
                                <div key={call.id} className="px-6 py-4 flex items-start gap-4">
                                  <div className="flex-shrink-0 mt-0.5">
                                    {call.call_type === 'outgoing'
                                      ? <PhoneOutgoing size={13} className="text-blue-400" />
                                      : <PhoneIncoming size={13} className="text-green-400" />
                                    }
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[11px] text-gray-500 font-bold uppercase mb-1">
                                      {cDate} • {cTime} &nbsp;·&nbsp;
                                      <span className={cn(
                                        'text-[10px] px-1.5 py-0.5 rounded-full font-bold',
                                        call.call_type === 'outgoing'
                                          ? 'bg-blue-500/10 text-blue-400'
                                          : 'bg-green-500/10 text-green-400'
                                      )}>
                                        {call.call_type === 'outgoing' ? 'יוצאת' : 'נכנסת'}
                                      </span>
                                    </div>
                                    <p className="text-sm text-gray-300 leading-relaxed line-clamp-3">{call.summary}</p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="py-28 text-center bg-[#1C1C1E] rounded-[40px] border border-dashed border-white/10">
                    <div className="w-16 h-16 bg-white/[0.02] rounded-full flex items-center justify-center mx-auto mb-6 text-gray-700">
                      <History size={32} />
                    </div>
                    <p className="text-gray-500 text-sm font-medium">אין היסטוריית שיחות עדיין</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── Tab: Tasks ─────────────────────────────────────────────── */}
          {activeTab === 'tasks' && (
            <section className="flex-1 flex flex-col space-y-4">

              {/* Sub-tab bar */}
              <div className="flex bg-[#1C1C1E] rounded-2xl p-1 gap-1 border border-white/5">
                <button
                  onClick={() => setTaskSubTab('todo')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all',
                    taskSubTab === 'todo' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-white'
                  )}
                >
                  לביצוע
                  {tasks.length > 0 && (
                    <span className="bg-white/20 text-white text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                      {tasks.length > 9 ? '9+' : tasks.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setTaskSubTab('done')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all',
                    taskSubTab === 'done' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-white'
                  )}
                >
                  בוצעו
                  {doneTasks.length > 0 && (
                    <span className={cn(
                      'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center',
                      taskSubTab === 'done' ? 'bg-white/20 text-white' : 'bg-gray-600/40 text-gray-400'
                    )}>
                      {doneTasks.length > 9 ? '9+' : doneTasks.length}
                    </span>
                  )}
                </button>
              </div>

              {/* ── Todo sub-tab ── */}
              {taskSubTab === 'todo' && (
                <div className="flex-1 space-y-4">
                  {tasks.length > 0 ? (
                    tasks.map((task) => {
                      const badge = dueBadge(task.due_category);
                      return (
                        <div key={task.id} className="bg-[#1C1C1E] rounded-[32px] border border-white/[0.03] overflow-hidden">
                          <div className="p-6 space-y-4">
                            <div className="flex items-start justify-between gap-4">
                              <p className="text-white font-medium leading-relaxed flex-1">{task.text}</p>
                              <span className={cn('text-[11px] font-black px-2.5 py-1 rounded-full whitespace-nowrap', badge.cls)}>
                                {badge.label}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <button
                                onClick={() => openContactView(task.phone_number, task.caller_name)}
                                className="text-right hover:text-blue-400 transition-colors"
                              >
                                <div className="text-sm text-gray-300 font-medium">{task.caller_name}</div>
                                <div className="text-xs text-gray-500">{task.phone_number ? `${task.phone_number} · ` : ''}{formatDateTime(task.created_at).date}</div>
                              </button>
                              <button
                                onClick={() => handleMarkTaskDone(task)}
                                className="flex items-center gap-2 bg-emerald-600/10 text-emerald-400 hover:bg-emerald-600 hover:text-white px-4 py-2 rounded-xl text-xs font-bold transition-all"
                              >
                                <Check size={14} />
                                סמן כבוצע
                              </button>
                            </div>
                          </div>
                          {task.summary && (
                            <>
                              <div className="border-t border-white/5" />
                              <button
                                onClick={() => setExpandedTaskId(prev => prev === task.id ? null : task.id)}
                                className="w-full flex items-center justify-end gap-1.5 px-6 py-2.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                              >
                                סיבת המשימה
                                {expandedTaskId === task.id
                                  ? <ChevronUp size={13} />
                                  : <ChevronDown size={13} />
                                }
                              </button>
                              {expandedTaskId === task.id && (
                                <div className="px-6 pb-5 border-r-2 border-amber-500/40 mx-4 mb-4 pr-3">
                                  {renderHighlightedSummary(task.summary, task.text)}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-28 text-center bg-[#1C1C1E] rounded-[40px] border border-dashed border-white/10">
                      <div className="w-16 h-16 bg-white/[0.02] rounded-full flex items-center justify-center mx-auto mb-6 text-gray-700">
                        <CheckSquare size={32} />
                      </div>
                      <p className="text-gray-500 text-sm font-medium">אין משימות פתוחות</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Done sub-tab ── */}
              {taskSubTab === 'done' && (
                <div className="flex-1 space-y-4">
                  {doneTasks.length > 0 ? (
                    doneTasks.map((task) => (
                      <div key={task.id} className="bg-[#1C1C1E] rounded-[32px] border border-white/[0.03] overflow-hidden opacity-70">
                        <div className="p-6 space-y-4">
                          <p className="text-gray-400 font-medium leading-relaxed line-through">{task.text}</p>
                          <div className="flex items-center justify-between">
                            <button
                              onClick={() => openContactView(task.phone_number, task.caller_name)}
                              className="text-right hover:text-blue-400 transition-colors"
                            >
                              <div className="text-sm text-gray-500 font-medium">{task.caller_name}</div>
                              <div className="text-xs text-gray-600">{task.phone_number ? `${task.phone_number} · ` : ''}{formatDateTime(task.created_at).date}</div>
                            </button>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleRestoreTask(task)}
                                className="flex items-center gap-2 text-gray-500 hover:text-white hover:bg-white/10 px-4 py-2 rounded-xl text-xs font-bold transition-all"
                              >
                                <RotateCcw size={13} />
                                החזר
                              </button>
                              <button
                                onClick={() => handleDeleteTask(task)}
                                className="flex items-center gap-2 text-red-500/50 hover:text-red-400 hover:bg-red-500/10 px-3 py-2 rounded-xl text-xs font-bold transition-all"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        </div>
                        {task.summary && (
                          <>
                            <div className="border-t border-white/5" />
                            <button
                              onClick={() => setExpandedTaskId(prev => prev === task.id ? null : task.id)}
                              className="w-full flex items-center justify-end gap-1.5 px-6 py-2.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                              סיבת המשימה
                              {expandedTaskId === task.id
                                ? <ChevronUp size={13} />
                                : <ChevronDown size={13} />
                              }
                            </button>
                            {expandedTaskId === task.id && (
                              <div className="px-6 pb-5 border-r-2 border-amber-500/40 mx-4 mb-4 pr-3">
                                {renderHighlightedSummary(task.summary, task.text)}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="py-28 text-center bg-[#1C1C1E] rounded-[40px] border border-dashed border-white/10">
                      <div className="w-16 h-16 bg-white/[0.02] rounded-full flex items-center justify-center mx-auto mb-6 text-gray-700">
                        <CheckSquare size={32} />
                      </div>
                      <p className="text-gray-500 text-sm font-medium">אין משימות שבוצעו</p>
                    </div>
                  )}
                </div>
              )}

            </section>
          )}

          {/* ── Tab: Search (AI Chat) ───────────────────────────────────── */}
          {activeTab === 'search' && (
            <section className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
              {/* Section header */}
              <div className="text-[11px] font-black text-gray-500 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                <MessageSquare size={14} />
                AI צ'אט — שיחות ומשימות
              </div>

              {/* Message list */}
              <div className="flex-1 overflow-y-auto space-y-4 pb-4" style={{ minHeight: 0 }}>
                {/* Intro message when empty */}
                {chatMessages.length === 0 && (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-blue-600 rounded-full flex-shrink-0 flex items-center justify-center mt-1">
                      <MessageSquare size={14} className="text-white" />
                    </div>
                    <div className="bg-[#1C1C1E] rounded-[20px] rounded-tr-md px-5 py-4 max-w-[85%] border border-white/5">
                      <p className="text-gray-200 text-sm leading-relaxed">שלום! שאל אותי כל שאלה על שיחותיך ומשימותיך. לדוגמה: "מי דיבר על חוזה?" או "מה אני צריך לעשות השבוע?"</p>
                    </div>
                  </div>
                )}

                {chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    className={msg.role === 'user' ? 'flex justify-start flex-row-reverse items-start gap-3' : 'flex items-start gap-3'}
                  >
                    {msg.role === 'assistant' && (
                      <div className="w-8 h-8 bg-blue-600 rounded-full flex-shrink-0 flex items-center justify-center mt-1">
                        <MessageSquare size={14} className="text-white" />
                      </div>
                    )}
                    <div
                      className={
                        msg.role === 'user'
                          ? 'bg-blue-600 rounded-[20px] rounded-tl-md px-5 py-4 max-w-[85%]'
                          : 'bg-[#1C1C1E] rounded-[20px] rounded-tr-md px-5 py-4 max-w-[85%] border border-white/5'
                      }
                    >
                      <p className="text-sm leading-relaxed text-white whitespace-pre-wrap">{msg.text}</p>
                    </div>
                  </div>
                ))}

                {/* Loading indicator */}
                {isAiSearching && (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-blue-600 rounded-full flex-shrink-0 flex items-center justify-center mt-1">
                      <MessageSquare size={14} className="text-white" />
                    </div>
                    <div className="bg-[#1C1C1E] rounded-[20px] rounded-tr-md px-5 py-4 border border-white/5">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={chatBottomRef} />
              </div>

              {/* Input area */}
              <div className="flex gap-3 mt-2 flex-shrink-0">
                <textarea
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendChatMessage();
                    }
                  }}
                  placeholder="שאל שאלה על שיחותיך..."
                  rows={1}
                  className="flex-1 bg-[#1C1C1E] text-white rounded-2xl px-5 py-4 text-sm outline-none focus:ring-2 focus:ring-blue-500/50 border border-white/5 resize-none"
                  dir="rtl"
                  style={{ minHeight: '52px', maxHeight: '120px' }}
                />
                <button
                  onClick={sendChatMessage}
                  disabled={!searchQuery.trim() || isAiSearching}
                  className="bg-blue-600 text-white px-5 rounded-2xl font-bold hover:bg-blue-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                >
                  שלח
                </button>
              </div>
            </section>
          )}

          {/* ── Call Detail Modal ──────────────────────────────────────── */}
          {viewingCall && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[60] flex items-end sm:items-center justify-center p-4 animate-in fade-in duration-500">
              <div className="bg-[#1C1C1E] w-full max-w-md rounded-[40px] p-10 space-y-10 shadow-2xl border border-white/5 animate-in slide-in-from-bottom-12">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-5">
                    <div className="w-16 h-16 bg-blue-600 rounded-3xl flex items-center justify-center text-white shadow-2xl shadow-blue-900/40">
                      <User size={32} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-2xl text-white">{viewingCall.caller_name}</h3>
                        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-bold">{viewingCall.caller_role}</span>
                        <span className={`flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${viewingCall.call_type === 'outgoing' ? 'bg-blue-500/10 text-blue-400' : 'bg-green-500/10 text-green-400'}`}>
                          {viewingCall.call_type === 'outgoing'
                            ? <><PhoneOutgoing size={13} />יוצאת</>
                            : <><PhoneIncoming size={13} />נכנסת</>
                          }
                        </span>
                      </div>
                      <p className="text-sm text-gray-300 font-medium tracking-wider">
                        {viewingCall.phone_number || <span className="italic text-gray-500">מספר לא זוהה</span>}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setViewingCall(null)}
                    className="w-12 h-12 flex items-center justify-center hover:bg-white/5 rounded-full text-gray-500 transition-colors"
                  >
                    <X size={24} />
                  </button>
                </div>

                <div className="space-y-8">
                  <div className="bg-white/[0.03] p-8 rounded-[32px] space-y-5 relative overflow-hidden border border-white/[0.03]">
                    <div className="text-[11px] font-black text-blue-500 uppercase tracking-[0.2em] flex items-center gap-2">
                      <MessageSquare size={16} />
                      סיכום שיחה
                    </div>
                    <div className="text-xl leading-relaxed text-gray-200 font-medium relative z-10">
                      {viewingCall.summary}
                    </div>
                    <div className="pt-4 border-t border-white/5 flex items-center justify-between text-[10px] text-gray-500 font-bold uppercase tracking-widest">
                      <span>{formatDateTime(viewingCall.created_at).date} • {formatDateTime(viewingCall.created_at).time}</span>
                      <span>משך: {formatDuration(viewingCall.duration)}</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <button
                    onClick={() => setViewingCall(null)}
                    className="py-5 rounded-2xl font-bold text-gray-500 hover:bg-white/5 transition-all"
                  >
                    סגור
                  </button>
                  <button
                    onClick={() => { simulateIncomingCall(viewingCall); setViewingCall(null); }}
                    className="bg-blue-600 text-white py-5 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-2xl shadow-blue-900/40"
                  >
                    דמה שיחה
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Contact Timeline Modal ─────────────────────────────────── */}
          {contactView && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[60] flex items-end sm:items-center justify-center p-4 animate-in fade-in duration-500">
              <div className="bg-[#1C1C1E] w-full max-w-md rounded-[40px] p-10 space-y-8 shadow-2xl border border-white/5 animate-in slide-in-from-bottom-12 max-h-[85vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between flex-shrink-0">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white">
                      <User size={28} />
                    </div>
                    <div>
                      <h3 className="font-bold text-xl text-white">{contactView.name}</h3>
                      <p className="text-sm text-gray-500">
                        {contactView.phone || <span className="italic">מספר לא זוהה</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setShareMode(!shareMode); setSelectedCallIds(new Set()); }}
                      className={cn(
                        'w-12 h-12 flex items-center justify-center rounded-full transition-colors',
                        shareMode ? 'bg-blue-600 text-white' : 'hover:bg-white/5 text-gray-500'
                      )}
                    >
                      <Share2 size={20} />
                    </button>
                    <button
                      onClick={() => { setContactView(null); setShareMode(false); setSelectedCallIds(new Set()); }}
                      className="w-12 h-12 flex items-center justify-center hover:bg-white/5 rounded-full text-gray-500 transition-colors"
                    >
                      <X size={24} />
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-black text-gray-500 uppercase tracking-[0.2em]">
                    {shareMode ? 'בחר שיחות לשיתוף' : 'כל השיחות עם איש קשר זה'}
                  </div>
                  {shareMode && selectedCallIds.size > 0 && (
                    <button
                      onClick={shareSelectedCalls}
                      className="flex items-center gap-1.5 bg-blue-600 text-white text-xs font-bold px-4 py-2 rounded-full hover:bg-blue-700 transition-colors"
                    >
                      <Share2 size={14} />
                      שתף ({selectedCallIds.size})
                    </button>
                  )}
                </div>

                {/* Scrollable call list */}
                <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                  {contactCalls.length > 0 ? (
                    contactCalls.map((call) => {
                      const { date, time } = formatDateTime(call.created_at);
                      const isSelected = selectedCallIds.has(call.id);
                      return (
                        <div
                          key={call.id}
                          onClick={shareMode ? () => toggleShareCallId(call.id) : undefined}
                          className={cn(
                            'w-full p-5 rounded-[20px] border text-right space-y-2 transition-colors',
                            shareMode ? 'cursor-pointer' : '',
                            isSelected ? 'bg-blue-600/10 border-blue-500/30' : 'bg-white/[0.03] border-white/[0.03]'
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {shareMode && (
                                <div className={cn(
                                  'w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                                  isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-600'
                                )}>
                                  {isSelected && <Check size={12} className="text-white" />}
                                </div>
                              )}
                              <span className="text-[11px] text-gray-500">{date} • {time} • {formatDuration(call.duration)}</span>
                            </div>
                            <span className={`flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${call.call_type === 'outgoing' ? 'bg-blue-500/10 text-blue-400' : 'bg-green-500/10 text-green-400'}`}>
                              {call.call_type === 'outgoing'
                                ? <><PhoneOutgoing size={13} />יוצאת</>
                                : <><PhoneIncoming size={13} />נכנסת</>
                              }
                            </span>
                          </div>
                          <p className="text-sm text-gray-300 leading-relaxed">{call.summary}</p>
                          <div className="flex items-center gap-4 mt-2">
                            {call.transcript && (
                              <button
                                onClick={() => handleResummarize(call)}
                                disabled={resummarizingId !== null}
                                className="flex items-center gap-1.5 text-amber-500 hover:text-amber-400 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <RotateCcw size={12} className={resummarizingId === call.id ? 'animate-spin' : ''} />
                                {resummarizingId === call.id ? 'מסכם...' : 'סכם מחדש (מפורט)'}
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteCall(call.id)}
                              className="flex items-center gap-1.5 text-red-500/60 hover:text-red-400 text-xs font-bold"
                            >
                              <Trash2 size={12} />
                              מחק
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-gray-600 text-sm text-center py-8">אין שיחות</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Settings Modal ─────────────────────────────────────────── */}
          {showSettings && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[60] flex items-end sm:items-center justify-center p-4 animate-in fade-in duration-500">
              <div className="bg-[#1C1C1E] w-full max-w-md rounded-[40px] p-10 space-y-8 shadow-2xl border border-white/5 animate-in slide-in-from-bottom-12">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-2xl text-white flex items-center gap-3">
                    <Settings size={24} className="text-blue-500" />
                    הגדרות
                  </h3>
                  <button
                    onClick={() => setShowSettings(false)}
                    className="w-12 h-12 flex items-center justify-center hover:bg-white/5 rounded-full text-gray-500 transition-colors"
                  >
                    <X size={24} />
                  </button>
                </div>

                {/* Gemini API key */}
                <div className="space-y-3">
                  <label className="text-[11px] font-black text-gray-500 uppercase tracking-[0.2em]">
                    מפתח Gemini API
                  </label>
                  <div className="flex gap-3">
                    <div className="flex-1 relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={apiKeyInput}
                        onChange={e => setApiKeyInput(e.target.value)}
                        placeholder="AIza..."
                        className="w-full bg-[#2C2C2E] text-white rounded-2xl px-5 py-4 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/50 border border-white/5 pr-14"
                        dir="ltr"
                      />
                      <button
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                      >
                        {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    <button
                      onClick={saveApiKey}
                      className="bg-blue-600 text-white px-6 rounded-2xl font-bold hover:bg-blue-700 transition-all"
                    >
                      שמור
                    </button>
                  </div>
                </div>

                {/* Android-only permission buttons */}
                {Capacitor.isNativePlatform() && (
                  <div className="space-y-4">
                    <div className="text-[11px] font-black text-gray-500 uppercase tracking-[0.2em]">
                      הרשאות אנדרואיד
                    </div>
                    <button
                      onClick={async () => {
                        try { await CallDetector.requestOverlayPermission(); } catch (e) { console.error(e); }
                      }}
                      className="w-full bg-[#2C2C2E] text-white py-4 rounded-2xl font-bold hover:bg-[#3C3C3E] transition-all flex items-center justify-between px-5 border border-white/5"
                    >
                      <span>הרשאת Overlay (חלונית צפה)</span>
                      <span className="text-[11px] text-blue-400 font-bold">הגדר ←</span>
                    </button>
                    <button
                      onClick={async () => {
                        try { await CallDetector.requestCallScreeningRole(); } catch (e) { console.error(e); }
                      }}
                      className="w-full bg-[#2C2C2E] text-white py-4 rounded-2xl font-bold hover:bg-[#3C3C3E] transition-all flex items-center justify-between px-5 border border-white/5"
                    >
                      <span>תפקיד סינון שיחות</span>
                      <span className="text-[11px] text-blue-400 font-bold">הגדר ←</span>
                    </button>
                  </div>
                )}

                <div className="text-[11px] text-gray-500 font-medium leading-relaxed">
                  המפתח נשמר באופן מקומי במכשיר ואינו נשלח לשרת כלשהו.
                </div>
              </div>
            </div>
          )}

          <footer className="pb-12 pt-4">
            <p className="text-center text-[11px] text-gray-500 font-bold uppercase tracking-[0.2em]">
              מערכת תיעוד וסיכום אוטומטית
            </p>
          </footer>
        </div>
      ) : (
        /* ── Live Call Screen ──────────────────────────────────────────── */
        <div className="fixed inset-0 bg-[#0A0A0B] z-50 flex flex-col animate-in fade-in duration-700">
          {isProcessing ? (
            /* ── Processing / Summary Screen ── */
            <div className="flex-1 relative flex flex-col overflow-hidden">
              {/* Top mini bar */}
              <div className="flex items-center gap-3 px-6 pt-10 pb-4">
                <div className="w-9 h-9 bg-[#2C2C2E] rounded-full flex items-center justify-center text-gray-500 flex-shrink-0">
                  <User size={18} />
                </div>
                <div className="text-right">
                  <p className="text-white font-bold text-sm leading-none">{incomingName}</p>
                  {incomingNumber && <p className="text-gray-500 text-xs mt-0.5 font-mono">{incomingNumber}</p>}
                </div>
              </div>

              {/* Blurred background — previous summary */}
              {selectedCall?.summary && (
                <div className="absolute bottom-0 left-0 right-0 px-6 pb-8 pointer-events-none">
                  <p className="text-gray-400 text-sm leading-relaxed blur-sm select-none opacity-30 text-right">
                    {selectedCall.summary}
                  </p>
                </div>
              )}

              {/* Center content */}
              <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center px-8">
                <div className="w-24 h-24 bg-[#1C1C1E] rounded-full flex items-center justify-center text-gray-500 border border-white/[0.05]">
                  <User size={44} strokeWidth={1.5} />
                </div>
                <div className="space-y-1">
                  <h2 className="text-3xl font-black text-white">{incomingName}</h2>
                  {incomingNumber && <p className="text-gray-500 text-base font-mono">{incomingNumber}</p>}
                </div>
                <div className="w-14 h-14 rounded-full border-4 border-[#2C2C2E] border-t-white animate-spin" />
                <div className="space-y-2">
                  <p className="text-white text-xl font-bold">מבצע סיכום שיחה</p>
                  <p className="text-gray-500 text-sm">פעולה זאת יכולה לקחת מספר דקות</p>
                </div>
              </div>
            </div>
          ) : (
            /* ── Calling Screen ── */
            <>
              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto px-6 pt-12 pb-4 space-y-4">

                {/* Recording badge (when active) */}
                {isRecording && (
                  <div className="flex justify-center">
                    <div className="bg-red-500 text-white px-5 py-2 rounded-full text-[11px] font-black uppercase tracking-[0.2em] flex items-center gap-2">
                      <div className="w-2 h-2 bg-white rounded-full animate-ping" />
                      מקליט
                    </div>
                  </div>
                )}

                {/* Header: small avatar + name + phone */}
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#2C2C2E] rounded-full flex items-center justify-center text-gray-500 flex-shrink-0">
                    <User size={24} strokeWidth={1.5} />
                  </div>
                  <div>
                    <h1 className="text-xl font-black text-white">{incomingName || 'מתקשר לא מזוהה'}</h1>
                    {incomingNumber && <p className="text-sm text-gray-500 font-mono">{incomingNumber}</p>}
                  </div>
                </div>

                {/* Blue badge */}
                <div className="inline-flex items-center gap-2 bg-blue-600/20 border border-blue-500/30 rounded-full px-4 py-1.5">
                  <MessageSquare size={13} className="text-blue-400 flex-shrink-0" />
                  <span className="text-blue-400 text-xs font-black uppercase tracking-wider">סיכום שיחה אחרונה</span>
                </div>

                {/* Main summary + date */}
                <div>
                  <p className="text-gray-200 text-base leading-relaxed">
                    {selectedCall?.summary ?? 'שיחה ראשונה. המערכת תתעד ותסכם הכל בסיום.'}
                  </p>
                  {selectedCall && (() => {
                    const { date, time } = formatDateTime(selectedCall.created_at);
                    return <p className="text-gray-600 text-xs mt-2">{time} {date}</p>;
                  })()}
                </div>

                {/* Divider */}
                <div className="border-t border-white/10" />

                {/* Previous calls */}
                {incomingCallHistory.length > 1 && (
                  <div className="space-y-3">
                    <p className="text-gray-500 text-xs font-black uppercase tracking-wider">שיחות קודמות:</p>
                    {incomingCallHistory.slice(1, 3).map(call => {
                      const { date, time } = formatDateTime(call.created_at);
                      return (
                        <div key={call.id}>
                          <p className="text-gray-300 text-sm leading-relaxed">{call.summary}</p>
                          <p className="text-gray-600 text-xs mt-1">{time} {date}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-16 bg-[#1C1C1E]/80 backdrop-blur-3xl border-t border-white/[0.03] flex flex-col items-center gap-12">
                <div className="flex items-center gap-5 text-white font-bold text-xl">
                  <div className="flex gap-1.5">
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="w-1.5 h-6 bg-blue-500/40 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
                    ))}
                  </div>
                  <span className="tracking-wide">{statusMessage}</span>
                </div>

                <div className="flex items-center gap-8">
                  {isRecording && (
                    <button
                      onClick={stopAutomatedRecording}
                      className="group relative flex items-center justify-center"
                    >
                      <div className="absolute inset-0 bg-red-500 rounded-full animate-ping opacity-10 group-hover:opacity-20" />
                      <div className="w-28 h-28 bg-red-500 text-white rounded-full flex items-center justify-center shadow-2xl relative z-10 hover:scale-110 active:scale-90 transition-all duration-300">
                        <Phone size={48} className="rotate-[135deg]" fill="currentColor" />
                      </div>
                    </button>
                  )}

                  {!isRecording && (
                    <button
                      onClick={startAutomatedRecording}
                      className="bg-white text-black px-12 py-6 rounded-[32px] font-black text-xl shadow-2xl hover:bg-gray-100 transition-all active:scale-[0.97] flex items-center gap-4"
                    >
                      <Mic size={28} />
                      התחל הקלטה ידנית
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
