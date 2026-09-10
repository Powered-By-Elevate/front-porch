import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CalendarPlus, Check, ChevronLeft, Pencil } from 'lucide-react';
import { myConnections, type OpenConnection } from '../lib/engine';
import { deviceFreeWindows } from '../lib/calendar';
import {
  addToCalendar,
  confirmPlan,
  fmtDay,
  fmtRange,
  planState,
  proposePlan,
  spreadSlots,
  submitAvailability,
  type PlanState,
  type Slot,
  type Win,
} from '../lib/plans';
import { usePorch } from '../store';

// The third door (PRD §5). Reads like the rest of the porch: no
// countdowns, no pressure, no reasons. You share the times you could be
// free, and only where the two of you line up ever becomes visible.

const DAYPARTS = [
  { key: 'morning', label: 'Morning', from: 8, to: 12 },
  { key: 'afternoon', label: 'Afternoon', from: 12, to: 17 },
  { key: 'evening', label: 'Evening', from: 17, to: 22 },
] as const;
const DAYS = 14;

function dayAt(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

function cellWin(offset: number, part: (typeof DAYPARTS)[number]): Win {
  const d = dayAt(offset);
  const s = new Date(d);
  s.setHours(part.from);
  const e = new Date(d);
  e.setHours(part.to);
  return { s: s.toISOString(), e: e.toISOString() };
}

// A cell you could still realistically propose inside: at least 45
// usable minutes left after the server's 30-minute lead.
function cellOpen(offset: number, part: (typeof DAYPARTS)[number]): boolean {
  const w = cellWin(offset, part);
  const usableFrom = Math.max(new Date(w.s).getTime(), Date.now() + 30 * 60000);
  return new Date(w.e).getTime() - usableFrom >= 45 * 60000;
}

function cellsFromWindows(wins: Win[]): Set<string> {
  const out = new Set<string>();
  for (let d = 0; d < DAYS; d++) {
    for (const part of DAYPARTS) {
      const c = cellWin(d, part);
      const cs = new Date(c.s).getTime();
      const ce = new Date(c.e).getTime();
      if (wins.some((w) => new Date(w.s).getTime() <= cs && ce <= new Date(w.e).getTime())) {
        out.add(`${d}|${part.key}`);
      }
    }
  }
  return out;
}

export function Plans() {
  const { id } = useParams();
  const people = usePorch((s) => s.people);
  const [conn, setConn] = useState<OpenConnection | null>(null);
  const [ps, setPs] = useState<PlanState | null>(null);
  const [closed, setClosed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const cs = await myConnections();
      const c = cs.find((x) => x.id === id) ?? null;
      if (!c) {
        setClosed(true);
        return;
      }
      setConn(c);
      setPs(await planState(c.id));
    } catch (e) {
      if (e instanceof Error && e.message === 'no_connection') setClosed(true);
      else setNote('Could not reach the porch just now. Pull back in a moment.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // First visit to the grid: let the device's calendar pre-fill it when
  // the native plugin exists (calendar.ts). Hand-editing always wins.
  useEffect(() => {
    if (ps && !ps.mine && cells.size === 0) {
      void deviceFreeWindows().then((w) => {
        if (w && w.length) setCells(cellsFromWindows(w));
      });
    }
  }, [ps, cells.size]);

  if (closed) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <p className="text-cream/70">This one has quietly closed. Back to the porch.</p>
        <Link to="/" className="mt-4 inline-block text-lamp-300">
          Home
        </Link>
      </div>
    );
  }

  if (!conn || !ps) return null;

  const name = people.find((p) => p.hash === conn.other_hash)?.name ?? 'Someone you know';

  const fail = (e: unknown) => {
    if (!(e instanceof Error)) return setNote('That did not go through. Try again.');
    if (e.message === 'no_connection') return setClosed(true);
    if (e.message === 'slot_outside_overlap' || e.message === 'bad_slot') {
      setNote('That time just moved. Here is what still works.');
      setChosen(null);
      void load();
      return;
    }
    if (e.message === 'plan_confirmed') {
      void load();
      return;
    }
    setNote('That did not go through. Try again.');
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote('');
    try {
      await fn();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const share = () =>
    act(async () => {
      const wins = [...cells].map((key) => {
        const [d, partKey] = key.split('|');
        return cellWin(Number(d), DAYPARTS.find((p) => p.key === partKey)!);
      });
      await submitAvailability(conn.id, wins);
      setEditing(false);
      setChosen(null);
    });

  const propose = (slot: Slot) =>
    act(async () => {
      await proposePlan(conn.id, slot.s.toISOString(), slot.e.toISOString());
      setChosen(null);
    });

  const startEditing = () => {
    setCells(cellsFromWindows(ps.my_windows ?? []));
    setEditing(true);
    setChosen(null);
  };

  const back = (
    <Link to={`/reveal/${conn.id}`} aria-label="Back" className="text-cream/60">
      <ChevronLeft size={22} />
    </Link>
  );

  const slotCard = (s: Date, e: Date) => (
    <div className="rounded-2xl bg-dusk-700 px-4 py-4">
      <p className="font-semibold">{fmtDay(s)}</p>
      <p className="text-cream/70">{fmtRange(s, e)}</p>
    </div>
  );

  const slotList = (heading: string) => {
    const slots = spreadSlots(ps.overlaps ?? []);
    if (slots.length === 0) {
      return (
        <div className="mt-8">
          <p className="text-cream/80">
            No shared free times in the next two weeks. A text or a call
            opens the door just as well. Or touch up your free times in
            case something moved.
          </p>
          <button onClick={startEditing} className="mt-4 flex items-center gap-2 rounded-xl bg-dusk-700 px-4 py-3 text-cream/80">
            <Pencil size={18} /> Edit my free times
          </button>
        </div>
      );
    }
    return (
      <div className="mt-8">
        <p className="text-cream/80">{heading}</p>
        <div className="mt-4 space-y-3">
          {slots.map((sl) => {
            const picked = chosen && chosen.s.getTime() === sl.s.getTime();
            return (
              <button
                key={sl.s.toISOString()}
                onClick={() => setChosen(picked ? null : sl)}
                className={`block w-full rounded-2xl px-4 py-4 text-left ${
                  picked ? 'bg-lamp-400 text-dusk-900' : 'bg-dusk-700'
                }`}
              >
                <p className="font-semibold">{fmtDay(sl.s)}</p>
                <p className={picked ? 'text-dusk-900/80' : 'text-cream/70'}>{fmtRange(sl.s, sl.e)}</p>
              </button>
            );
          })}
        </div>
        {chosen && (
          <button
            disabled={busy}
            onClick={() => void propose(chosen)}
            className="mt-4 w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
          >
            Put this time on the table
          </button>
        )}
        <button onClick={startEditing} className="mt-3 flex items-center gap-2 rounded-xl px-1 py-2 text-sm text-cream/60">
          <Pencil size={16} /> Edit my free times
        </button>
      </div>
    );
  };

  let body;
  if (ps.plan && ps.plan.state === 'confirmed') {
    const s = new Date(ps.plan.starts_at);
    const e = new Date(ps.plan.ends_at);
    body = (
      <div className="mt-8">
        <h2 className="text-2xl font-semibold">It&apos;s a plan.</h2>
        <p className="mt-2 text-cream/80">You and {name} both said yes to this time.</p>
        <div className="mt-4">{slotCard(s, e)}</div>
        <button
          onClick={() => addToCalendar(name, s, e, conn.id)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
        >
          <CalendarPlus size={20} /> Add to my calendar
        </button>
        <p className="mt-3 text-sm text-cream/60">
          Put it on your calendar and it outlives the 48 hours.
        </p>
      </div>
    );
  } else if (editing || !ps.mine) {
    body = (
      <div className="mt-8">
        <p className="text-cream/80">
          Pick the times you could be free over the next two weeks. {name}{' '}
          never sees your calendar or your reasons. Only the times you both
          pick ever show up, and only to the two of you.
        </p>
        <div className="mt-5 space-y-2">
          {Array.from({ length: DAYS }, (_, d) => {
            const anyOpen = DAYPARTS.some((p) => cellOpen(d, p));
            if (!anyOpen) return null;
            return (
              <div key={d} className="flex items-center gap-2">
                <p className="w-16 shrink-0 text-sm text-cream/60">
                  {new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(dayAt(d))}
                </p>
                {DAYPARTS.map((part) => {
                  const key = `${d}|${part.key}`;
                  const open = cellOpen(d, part);
                  const on = cells.has(key);
                  return (
                    <button
                      key={key}
                      disabled={!open}
                      onClick={() => {
                        const next = new Set(cells);
                        if (on) next.delete(key);
                        else next.add(key);
                        setCells(next);
                      }}
                      className={`flex-1 rounded-xl py-3 text-sm ${
                        on ? 'bg-lamp-400 font-semibold text-dusk-900' : 'bg-dusk-700 text-cream/70'
                      } ${open ? '' : 'opacity-30'}`}
                    >
                      {part.label}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <button
          disabled={busy || cells.size === 0}
          onClick={() => void share()}
          className="mt-5 w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900 disabled:opacity-40"
        >
          Share my free times
        </button>
        {editing && (
          <button onClick={() => setEditing(false)} className="mt-3 w-full rounded-xl px-4 py-2 text-sm text-cream/60">
            Never mind
          </button>
        )}
      </div>
    );
  } else if (ps.plan) {
    const s = new Date(ps.plan.starts_at);
    const e = new Date(ps.plan.ends_at);
    body = (
      <div className="mt-8">
        {ps.plan.by_me ? (
          <>
            <p className="text-cream/80">You put a time on the table. {name} can make it a plan, or pick another.</p>
            <div className="mt-4">{slotCard(s, e)}</div>
          </>
        ) : (
          <>
            <p className="text-cream/80">{name} picked a time.</p>
            <div className="mt-4">{slotCard(s, e)}</div>
            <button
              disabled={busy}
              onClick={() => void act(() => confirmPlan(conn.id))}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
            >
              <Check size={20} /> That works
            </button>
          </>
        )}
        {slotList(ps.plan.by_me ? 'Or change it to one of these.' : 'Or put a different time on the table.')}
      </div>
    );
  } else if (!ps.theirs) {
    body = (
      <div className="mt-8">
        <p className="text-cream/80">
          Your free times are in. When {name} shares theirs, the times you
          are both free show up right here.
        </p>
        <button onClick={startEditing} className="mt-4 flex items-center gap-2 rounded-xl bg-dusk-700 px-4 py-3 text-cream/80">
          <Pencil size={18} /> Edit my free times
        </button>
      </div>
    );
  } else {
    body = slotList(`You and ${name} are both free at these times. Pick one to put on the table.`);
  }

  return (
    <div className="mx-auto max-w-md px-5 pb-24 pt-10">
      {back}
      <h1 className="mt-6 text-2xl font-semibold">Make Plans</h1>
      {note && <p className="mt-3 text-sm text-lamp-300">{note}</p>}
      {body}
    </div>
  );
}
