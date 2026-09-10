import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, MessageCircle, Phone } from 'lucide-react';
import { myConnections, type OpenConnection } from '../lib/engine';
import { usePorch } from '../store';

// The match screen. The blessed copy renders HERE with the name, because
// the name lives only on this device (the push is nameless by
// architecture, PRD §4.4). No countdown is ever shown: "you have 48
// hours" is a sentence, not a timer (PRD law 10).
export function Reveal() {
  const { id } = useParams();
  const people = usePorch((s) => s.people);
  const [conn, setConn] = useState<OpenConnection | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    void myConnections().then((cs) => {
      const c = cs.find((x) => x.id === id) ?? null;
      setConn(c);
      if (!c) setGone(true);
    });
  }, [id]);

  if (gone) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <p className="text-cream/70">This one has quietly closed. Back to the porch.</p>
        <Link to="/" className="mt-4 inline-block text-lamp-300">
          Home
        </Link>
      </div>
    );
  }

  if (!conn) return null;

  const person = people.find((p) => p.hash === conn.other_hash);
  const name = person?.name ?? 'Someone you know';

  return (
    <div className="mx-auto max-w-md px-5 py-10">
      <Link to="/" aria-label="Back" className="text-cream/60">
        <ChevronLeft size={22} />
      </Link>

      <div className="mt-10 text-center">
        <div className="mx-auto h-20 w-20 rounded-full bg-lamp-400 shadow-[0_0_40px_12px_rgba(245,179,76,0.5)]" />
        <h1 className="mt-8 text-3xl font-semibold">Both lights are on.</h1>
        <p className="mt-3 text-cream/80">
          You and {name} both want to connect. You have 48 hours.
        </p>
      </div>

      <div className="mt-12 space-y-3">
        {person && (
          <a
            href={`sms:${person.number}`}
            className="flex items-center justify-center gap-2 rounded-2xl bg-dusk-700 px-4 py-4 font-medium"
          >
            <MessageCircle size={20} /> Text
          </a>
        )}
        {person && (
          <a
            href={`tel:${person.number}`}
            className="flex items-center justify-center gap-2 rounded-2xl bg-dusk-700 px-4 py-4 font-medium"
          >
            <Phone size={20} /> Call
          </a>
        )}
        <Link
          to={`/plans/${conn.id}`}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-dusk-700 px-4 py-4 font-medium"
        >
          <CalendarDays size={20} /> Make Plans
        </Link>
      </div>
    </div>
  );
}
