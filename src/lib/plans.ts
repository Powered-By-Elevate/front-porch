import { rpc } from './engine';

// Make Plans, client side. The server owns the truth (consent gate,
// overlap computation, slot validation), this file shapes it for people:
// turning overlap ranges into a small spread of concrete times across
// varied dayparts (PRD §5: an evening one day, an afternoon another, a
// morning another), and turning a confirmed plan into a calendar event.

export type Win = { s: string; e: string };
export type PlanRow = {
  starts_at: string;
  ends_at: string;
  by_me: boolean;
  state: 'proposed' | 'confirmed';
};
export type PlanState = {
  mine: boolean;
  theirs: boolean;
  my_windows: Win[] | null;
  overlaps: Win[] | null;
  plan: PlanRow | null;
};

export const planState = (connId: string) =>
  rpc('plan_state', { p_connection: connId }) as Promise<PlanState>;
export const submitAvailability = (connId: string, windows: Win[]) =>
  rpc('submit_availability', { p_connection: connId, p_windows: windows });
export const proposePlan = (connId: string, startsAt: string, endsAt: string) =>
  rpc('propose_plan', { p_connection: connId, p_starts: startsAt, p_ends: endsAt });
export const confirmPlan = (connId: string) => rpc('confirm_plan', { p_connection: connId });

export type Slot = { s: Date; e: Date };
export type Daypart = 'morning' | 'afternoon' | 'evening';

export function daypartOf(d: Date): Daypart {
  const h = d.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const MIN = 60000;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const ceilToHalfHour = (d: Date) => new Date(Math.ceil(d.getTime() / (30 * MIN)) * 30 * MIN);

// Concrete times out of overlap ranges: 90-minute slots (shorter when the
// window is), the first viable one per local day and daypart. The spread
// then takes one slot per day, rotating toward the daypart used least, so
// the offer naturally reads evening one day, afternoon another, morning
// another. When fewer days exist than choices deserve, a second pass adds
// other dayparts from the same days rather than offering almost nothing.
export function spreadSlots(overlaps: Win[], max = 6): Slot[] {
  const buckets = new Map<string, Slot>();
  for (const w of overlaps) {
    const end = new Date(w.e);
    for (let t = ceilToHalfHour(new Date(w.s)); t < end; t = new Date(t.getTime() + 30 * MIN)) {
      const e = new Date(Math.min(t.getTime() + 90 * MIN, end.getTime()));
      if (e.getTime() - t.getTime() < 45 * MIN) continue;
      const key = `${dayKey(t)}|${daypartOf(t)}`;
      if (!buckets.has(key)) buckets.set(key, { s: new Date(t), e });
    }
  }
  const all = [...buckets.values()].sort((a, b) => a.s.getTime() - b.s.getTime());
  const used: Record<Daypart, number> = { morning: 0, afternoon: 0, evening: 0 };
  const picked: Slot[] = [];
  const days = [...new Set(all.map((sl) => dayKey(sl.s)))];

  for (const day of days) {
    if (picked.length >= max) break;
    const options = all
      .filter((sl) => dayKey(sl.s) === day)
      .sort((a, b) => used[daypartOf(a.s)] - used[daypartOf(b.s)] || a.s.getTime() - b.s.getTime());
    picked.push(options[0]);
    used[daypartOf(options[0].s)] += 1;
  }
  if (picked.length < 3) {
    const rest = all
      .filter((sl) => !picked.includes(sl))
      .sort((a, b) => used[daypartOf(a.s)] - used[daypartOf(b.s)] || a.s.getTime() - b.s.getTime());
    for (const sl of rest) {
      if (picked.length >= 3) break;
      picked.push(sl);
      used[daypartOf(sl.s)] += 1;
    }
  }
  return picked.sort((a, b) => a.s.getTime() - b.s.getTime());
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const fmtDay = (d: Date) => DAY_FMT.format(d);
export const fmtRange = (s: Date, e: Date) => `${TIME_FMT.format(s)} to ${TIME_FMT.format(e)}`;

// One event, added by each device to its own calendar. A true shared
// invite would need email addresses, which Front Porch never has (phone
// is the whole identity), so both sides add the same event locally. The
// name is fine here: it comes from this device's address book and goes
// into this device's calendar, never through the server (PRD law 7).
export function planIcs(name: string, s: Date, e: Date, connId: string): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/[,]/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Front Porch//EN',
    'BEGIN:VEVENT',
    `UID:fp-${connId}@frontporch.local`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(s)}`,
    `DTEND:${fmt(e)}`,
    `SUMMARY:${esc(`Plans with ${name}`)}`,
    'DESCRIPTION:Made on Front Porch.',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// Web path: hand the browser an .ics it opens with the calendar. At
// native-wrap time this routes through the share sheet instead (write
// the file, then @capacitor/share), because WKWebView has no downloads.
export function addToCalendar(name: string, s: Date, e: Date, connId: string) {
  const blob = new Blob([planIcs(name, s, e, connId)], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'front-porch-plan.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
