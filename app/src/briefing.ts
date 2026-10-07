// The spoken briefing, prepared once per trip and kept on the phone: Gemma's
// text, then Piper's wav. The Plan screen starts this as soon as a trip is
// saved, so it is ready before the hiker leaves signal behind; the trail screen
// asks again and gets the same promise (or the cached copy) back.

import { api } from "./api";
import { loadAudio, saved, saveAudio } from "./store";

export interface Briefing {
  text: string;
  audio: Blob | null;
  audioError: string | null;
}

const inflight = new Map<number, Promise<Briefing>>();

async function prepare(tripId: number): Promise<Briefing> {
  let text = saved.briefing(tripId);
  if (!text) {
    text = (await api.briefing(tripId)).briefing;
    saved.setBriefing(tripId, text);
  }
  let audio = await loadAudio(tripId);
  let audioError: string | null = null;
  if (!audio) {
    try {
      audio = await api.briefingAudio(tripId);
      await saveAudio(tripId, audio);
    } catch (e) {
      audioError = e instanceof Error ? e.message : String(e);
    }
  }
  return { text, audio, audioError };
}

export function prepareBriefing(tripId: number): Promise<Briefing> {
  let p = inflight.get(tripId);
  if (!p) {
    p = prepare(tripId);
    inflight.set(tripId, p);
    // a failure must not stick — the next call (e.g. back in signal) retries
    p.then(
      (b) => {
        if (!b.audio) inflight.delete(tripId);
      },
      () => inflight.delete(tripId),
    );
  }
  return p;
}
