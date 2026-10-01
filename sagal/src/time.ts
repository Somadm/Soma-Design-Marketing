/**
 * Everything is stored in UTC. Sabah plans in Europe/Helsinki, so plan dates and
 * slot times are Helsinki wall-clock values converted here (DST-aware).
 */
export const TZ = "Europe/Helsinki";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function helsinkiParts(d: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of Helsinki from UTC at instant `d`, in minutes (120 in winter, 180 in summer). */
export function helsinkiOffsetMinutes(d: Date): number {
  const p = helsinkiParts(d);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** "2026-10-01" + "12:30" (Helsinki) → UTC Date. */
export function helsinkiToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  if (![y, m, d, h, mi].every(Number.isFinite)) throw new Error(`Invalid Helsinki date/time: ${date} ${time}`);
  const naive = Date.UTC(y, m - 1, d, h, mi);
  // Two passes settle the offset across DST changes.
  let guess = new Date(naive - helsinkiOffsetMinutes(new Date(naive)) * 60000);
  guess = new Date(naive - helsinkiOffsetMinutes(guess) * 60000);
  return guess;
}

/** UTC Date → Helsinki calendar date "YYYY-MM-DD". */
export function helsinkiDate(d: Date): string {
  const p = helsinkiParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** UTC Date → Helsinki time "HH:MM". */
export function helsinkiTime(d: Date): string {
  const p = helsinkiParts(d);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Monday of the Helsinki week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
  return addDays(date, -dow);
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

export function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Inside quiet hours (start–end, Helsinki, may wrap past midnight)? */
export function inQuietHours(now: Date, start = "21:00", end = "08:00"): boolean {
  const t = helsinkiTime(now);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}
