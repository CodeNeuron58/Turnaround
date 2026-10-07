/** Shared number/time formatting — matches the design's typographic voice. */

export function fmtClock(sec: number): string {
  const a = Math.abs(Math.round(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function fmtHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${m} m` : `${m} m`;
}

export function fmtMargin(min: number | null): string {
  if (min == null) return "—";
  const body = fmtHM(Math.abs(min));
  return (min < 0 ? "−" : "+") + body;
}

export function fmtTimeOfDay(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function startLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) +
    " · " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}
