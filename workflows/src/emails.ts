// The two emails the safety timer sends — the overdue alert and the all-clear.
// Each has an HTML version (designed in the app's cream & forest style, built
// from tables and inline styles so Gmail, Outlook and phone clients agree) and
// a plain-text version for clients that don't render HTML.

import type { Email } from "./mail";
import type { GeoPoint, TripDetails } from "./workflows";

const C = {
  bg: "#F3F0E6",
  card: "#FBFAF5",
  line: "#E2DDCF",
  ink: "#1E2620",
  muted: "#5E665F",
  green: "#1F4D35",
  greenSoft: "#E3EDE4",
  red: "#B54A3B",
  amberBg: "#FBF0D9",
  amberLine: "#F0DDB3",
  amberText: "#6B4810",
};
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Mon 12 Oct, 4:05 am" — the time zone is stated once per email (zoneNote). */
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

/** The contact may not share the hiker's time zone, so say which one these are. */
function zoneNote(): string {
  const zone = new Date().toLocaleString("en-GB", { timeZoneName: "short" }).split(" ").pop() ?? "";
  return `Times are ${zone} (the hiker's time zone).`;
}

const mapUrl = (p: GeoPoint) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
const osmUrl = (p: GeoPoint) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`;
const coords = (p: GeoPoint) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

function shell(title: string, preheader: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 6px 16px;font-family:${SERIF};font-size:22px;color:${C.green};">&#9650;&nbsp;Turnaround</td></tr>
${body}
<tr><td style="padding:18px 6px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.muted};">
Sent automatically by Turnaround, an open-source hiking companion running on the hiker's own computer.
</td></tr>
</table></td></tr></table></body></html>`;
}

function drillBanner(): string {
  return `<tr><td style="padding:0 0 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="background:${C.amberBg};border:1px solid ${C.amberLine};border-radius:14px;padding:12px 16px;font-family:${SANS};font-size:14px;line-height:1.5;color:${C.amberText};">
<strong>This is a planned drill — no action needed.</strong> The deadline was shortened on purpose; a real alert looks exactly like this.
</td></tr></table></td></tr>`;
}

function header(color: string, kicker: string, headline: string): string {
  return `<tr><td style="background:${color};border-radius:20px 20px 0 0;padding:26px 28px 24px;">
<div style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF;opacity:.85;">${esc(kicker)}</div>
<div style="font-family:${SERIF};font-size:30px;line-height:1.15;color:#FFFFFF;padding-top:8px;">${headline}</div>
</td></tr>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background:${C.green};border-radius:999px;"><a href="${esc(href)}" style="display:inline-block;padding:14px 24px;font-family:${SANS};font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;">${esc(label)}</a></td>
</tr></table>`;
}

function facts(rows: Array<[string, string]>): string {
  const trs = rows
    .map(
      ([k, v], i) => `<tr>
<td style="padding:11px 0;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${SANS};font-size:13px;color:${C.muted};width:36%;padding-right:12px;vertical-align:top;">${esc(k)}</td>
<td style="padding:11px 0;${i ? `border-top:1px solid ${C.line};` : ""}font-family:${SANS};font-size:15px;color:${C.ink};vertical-align:top;">${v}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;">${trs}</table>
<p style="margin:8px 0 0;font-family:${SANS};font-size:12px;color:${C.muted};">${esc(zoneNote())}</p>`;
}

function card(inner: string): string {
  return `<tr><td style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 20px 20px;padding:24px 28px 26px;font-family:${SANS};font-size:16px;line-height:1.55;color:${C.ink};">${inner}</td></tr>`;
}

export function renderAlert(trip: TripDetails): Email {
  const hiker = esc(trip.hiker);
  const route = esc(trip.routeName);
  const overdueMin = Math.max(0, Math.round((Date.now() - new Date(trip.backByIso).getTime()) / 60000));
  const overdue = trip.drill ? "" : ` — that's ${overdueMin} min ago`;

  const rows: Array<[string, string]> = [
    ["Route", `${route} <span style="color:${C.muted};">· grade T${trip.tGrade}</span>`],
    ["Distance", `${trip.distanceKm} km · ${Math.round(trip.climbM)} m of climbing · high point ${Math.round(trip.highestM)} m`],
    ["Started", esc(when(trip.startedAtIso))],
    ["Expected back", `${esc(when(trip.expectedBackIso))}${trip.breaksMin ? ` <span style="color:${C.muted};">(${trip.breaksMin} min of breaks included)</span>` : ""}`],
    ["Should be back by", `<strong>${esc(when(trip.backByIso))}</strong>`],
    ...(trip.sunsetIso ? ([["Sunset", esc(when(trip.sunsetIso))]] as Array<[string, string]>) : []),
    ...(trip.rainChancePct != null ? ([["Rain chance", `${Math.round(trip.rainChancePct)}%`]] as Array<[string, string]>) : []),
    ...(trip.trailhead
      ? ([["Set off from", `${coords(trip.trailhead)} · <a href="${esc(osmUrl(trip.trailhead))}" style="color:${C.green};">OpenStreetMap</a>`]] as Array<[string, string]>)
      : []),
    ...(trip.routeCenter
      ? ([["Middle of the route", `<a href="${esc(mapUrl(trip.routeCenter))}" style="color:${C.green};">${coords(trip.routeCenter)}</a>`]] as Array<[string, string]>)
      : []),
  ];

  const html = shell(
    `${trip.hiker} is overdue`,
    `${trip.hiker} hasn't checked in from ${trip.routeName}. Here's where they set off.`,
    `${trip.drill ? drillBanner() : ""}
${header(C.red, "Overdue — no check-in", `${hiker} hasn't checked in from ${route}`)}
${card(`<p style="margin:0 0 20px;">You're ${hiker}'s emergency contact. They started this hike at <strong>${esc(when(trip.startedAtIso))}</strong> and should have been back by <strong>${esc(when(trip.backByIso))}</strong>${overdue}. They haven't checked in.</p>
${trip.trailhead ? button(mapUrl(trip.trailhead), "Open where they set off") : ""}
${facts(rows)}
<div style="font-family:${SERIF};font-size:20px;color:${C.ink};padding-top:26px;">What to do</div>
<ol style="margin:10px 0 0;padding-left:20px;font-size:15px;line-height:1.6;color:${C.ink};">
<li style="margin-bottom:6px;">Call or message them — a flat phone or a long lunch is the usual reason.</li>
<li style="margin-bottom:6px;">If you can't reach them, the route above is the one they planned, starting from where they set off.</li>
<li>If it's getting dark or you're worried, contact local emergency services and share this email.</li>
</ol>
<p style="margin:20px 0 0;font-size:13px;color:${C.muted};">If they check in, we'll email you straight away that they're safe.</p>`)}`,
  );

  const text = [
    ...(trip.drill ? ["THIS IS A PLANNED DRILL — no action needed. The deadline was shortened on purpose;", "a real alert looks exactly like the rest of this email.", ""] : []),
    `${trip.hiker} hasn't checked in from "${trip.routeName}".`,
    "",
    `You're ${trip.hiker}'s emergency contact in Turnaround. They started at ${when(trip.startedAtIso)}`,
    `and should have been back by ${when(trip.backByIso)}${overdue}.`,
    "",
    ...(trip.trailhead ? [`  Set off from:      ${coords(trip.trailhead)} — ${mapUrl(trip.trailhead)}`] : []),
    ...(trip.routeCenter ? [`  Middle of route:   ${coords(trip.routeCenter)} — ${mapUrl(trip.routeCenter)}`] : []),
    `  Route:             ${trip.routeName} (grade T${trip.tGrade})`,
    `  Distance:          ${trip.distanceKm} km, ${Math.round(trip.climbM)} m of climbing, high point ${Math.round(trip.highestM)} m`,
    `  Expected back:     ${when(trip.expectedBackIso)}${trip.breaksMin ? ` (${trip.breaksMin} min of breaks included)` : ""}`,
    ...(trip.sunsetIso ? [`  Sunset:            ${when(trip.sunsetIso)}`] : []),
    ...(trip.rainChancePct != null ? [`  Rain chance:       ${Math.round(trip.rainChancePct)}%`] : []),
    "",
    "What to do:",
    "  1. Call or message them — a flat phone or a long lunch is the usual reason.",
    "  2. If you can't reach them, the route above is the one they planned, starting from where they set off.",
    "  3. If it's getting dark or you're worried, contact local emergency services and share this email.",
    "",
    zoneNote(),
    "",
    "If they check in, we'll email you straight away that they're safe.",
    "",
    "— Turnaround (sent automatically from the hiker's own computer)",
  ].join("\n");

  return {
    to: trip.contactEmail,
    subject: `${trip.drill ? "[DRILL] " : ""}Turnaround alert — ${trip.hiker} is overdue on "${trip.routeName}"`,
    text,
    html,
  };
}

export function renderAllClear(trip: TripDetails, checkedInIso = new Date().toISOString()): Email {
  const hiker = esc(trip.hiker);
  const route = esc(trip.routeName);
  const html = shell(
    `${trip.hiker} is safe`,
    `${trip.hiker} checked in — you can stand down.`,
    `${trip.drill ? drillBanner() : ""}
${header(C.green, "All clear", `${hiker} is safe`)}
${card(`<p style="margin:0;">${hiker} just checked in from <strong>${route}</strong>. They're off the trail — you can stand down and ignore our earlier alert.</p>
${facts([
  ["Started", esc(when(trip.startedAtIso))],
  ["Checked in", `<strong>${esc(when(checkedInIso))}</strong>`],
])}
<p style="margin:20px 0 0;font-size:13px;color:${C.muted};">Thanks for being the person they trust with this.</p>`)}`,
  );
  const text = [
    ...(trip.drill ? ["THIS IS A PLANNED DRILL — no action needed.", ""] : []),
    `${trip.hiker} just checked in from "${trip.routeName}" — they're off the trail.`,
    "You can stand down; ignore our earlier overdue alert.",
    "",
    `  Started:     ${when(trip.startedAtIso)}`,
    `  Checked in:  ${when(checkedInIso)}`,
    `  ${zoneNote()}`,
    "",
    "Thanks for being the person they trust with this.",
    "",
    "— Turnaround (sent automatically from the hiker's own computer)",
  ].join("\n");
  return {
    to: trip.contactEmail,
    subject: `${trip.drill ? "[DRILL] " : ""}Turnaround — ${trip.hiker} is safe`,
    text,
    html,
  };
}
