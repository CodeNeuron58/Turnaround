// What the phone keeps so a trip survives a refresh, a discarded background
// tab, or no signal: the active trip, a check-in tapped without signal, the
// last summary, and the briefing (text in localStorage; the wav in IndexedDB,
// too big for localStorage). Every access is guarded — private windows and
// blocked storage must degrade to "not saved", never to a crash.

import type { CheckinResult, Prediction, Route, Sunset, Trip } from "./api";

/** Everything the trail and summary screens need, minus the GPX File itself. */
export interface SavedPlan {
  route: Route;
  prediction: Prediction;
  sunset: Sunset;
  trip: Trip;
}

export interface PendingCheckin {
  tripId: number;
  actualMin: number;
  tappedAt: number;
}

const ACTIVE = "turnaround-active-trip";
const PENDING = "turnaround-pending-checkin";
const RESULT = "turnaround-last-result";
const HIKER = "turnaround-hiker-name";
const briefingKey = (id: number) => `turnaround-briefing-${id}`;

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the in-memory state still works */
  }
}

export const saved = {
  active: () => read<SavedPlan>(ACTIVE),
  setActive: (p: SavedPlan | null) => write(ACTIVE, p),
  pending: () => read<PendingCheckin>(PENDING),
  setPending: (p: PendingCheckin | null) => write(PENDING, p),
  result: () => read<{ plan: SavedPlan; result: CheckinResult }>(RESULT),
  setResult: (r: { plan: SavedPlan; result: CheckinResult } | null) => write(RESULT, r),
  hikerName: () => read<string>(HIKER) ?? "",
  setHikerName: (n: string) => write(HIKER, n || null),
  briefing: (id: number) => read<string>(briefingKey(id)),
  setBriefing: (id: number, text: string) => write(briefingKey(id), text),
};

// --- briefing audio (IndexedDB) ---

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("turnaround", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("audio");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadAudio(tripId: number): Promise<Blob | null> {
  try {
    const dbh = await openAudioDb();
    return await new Promise((resolve) => {
      const req = dbh.transaction("audio").objectStore("audio").get(tripId);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveAudio(tripId: number, blob: Blob): Promise<void> {
  try {
    const dbh = await openAudioDb();
    await new Promise<void>((resolve) => {
      const tx = dbh.transaction("audio", "readwrite");
      tx.objectStore("audio").put(blob, tripId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* not cached — it plays from memory this session */
  }
}
