import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, UserPlus } from 'lucide-react';
import { Light } from '../components/Light';
import { usePorch, type Person } from '../store';
import { hashPhone, toE164 } from '../lib/phone';
import { myConnections, myLights, setLight, unsetLight, whoIsOn, type OpenConnection } from '../lib/engine';

export function Porch() {
  const { people, lights, onFP, addPerson, setLights, setOnFP } = usePorch();
  const [connections, setConnections] = useState<OpenConnection[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setLights(await myLights());
      setConnections(await myConnections());
      setOnFP(await whoIsOn(people.map((p) => p.hash)));
    } catch {
      // Offline or unconfigured: the porch renders from local state.
    }
  }, [people, setLights, setOnFP]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const toggle = async (p: Person) => {
    const isOn = lights.includes(p.hash);
    setNotice('');
    // Instant in the UI, per the law. The server owns everything after.
    setLights(isOn ? lights.filter((h) => h !== p.hash) : [...lights, p.hash]);
    try {
      if (isOn) await unsetLight(p.hash);
      else await setLight(p.hash);
    } catch (e) {
      setLights(isOn ? [...lights] : lights.filter((h) => h !== p.hash));
      if (e instanceof Error && e.message === 'light_cap') {
        setNotice('Ten lights is the porch limit for now. Turn one off first.');
      } else if (e instanceof Error && e.message === 'blocked_target') {
        setNotice('You have this person blocked. Unblock them in settings first.');
      }
    }
  };

  const add = async () => {
    const e164 = toE164(number);
    if (!e164 || !name.trim()) {
      setNotice('A name and a full phone number, and they are on your porch.');
      return;
    }
    addPerson({ name: name.trim(), number: e164, hash: await hashPhone(e164) });
    setName('');
    setNumber('');
    setAdding(false);
    setNotice('');
    void refresh();
  };

  const personFor = (hash: string) => people.find((p) => p.hash === hash);

  return (
    <div className="mx-auto max-w-md px-5 pb-24 pt-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Front Porch</h1>
          <p className="text-sm text-cream/60">Leave your light on.</p>
        </div>
        <Link to="/settings" aria-label="Settings" className="p-2 text-cream/60">
          <Settings size={22} />
        </Link>
      </header>

      {connections.map((c) => {
        const p = personFor(c.other_hash);
        return (
          <Link
            key={c.id}
            to={`/reveal/${c.id}`}
            className="mt-6 block rounded-2xl bg-lamp-400 px-4 py-4 font-semibold text-dusk-900 shadow-[0_0_24px_6px_rgba(245,179,76,0.35)]"
          >
            Both lights are on. {p ? `You and ${p.name}.` : ''} Come see.
          </Link>
        );
      })}

      {notice && <p className="mt-4 text-sm text-lamp-300">{notice}</p>}

      <ul className="mt-8 space-y-3">
        {people.map((p) => (
          <li key={p.hash} className="flex items-center justify-between rounded-2xl bg-dusk-700 px-4 py-3">
            <div>
              <p className="font-medium">{p.name}</p>
              {onFP.includes(p.hash) && <p className="text-xs text-lamp-300">on Front Porch</p>}
            </div>
            <Light on={lights.includes(p.hash)} onToggle={() => void toggle(p)} />
          </li>
        ))}
      </ul>

      {people.length === 0 && !adding && (
        <p className="mt-10 text-cream/60">
          Your porch is empty. Add someone you would love to hear from. They
          will never know, unless their light is on for you too.
        </p>
      )}

      {adding ? (
        <div className="mt-6 space-y-3 rounded-2xl bg-dusk-700 p-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name (stays on your phone)"
            className="w-full rounded-xl bg-dusk-600 px-4 py-3 outline-none focus:ring-2 focus:ring-lamp-400"
          />
          <input
            type="tel"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Their phone number"
            className="w-full rounded-xl bg-dusk-600 px-4 py-3 outline-none focus:ring-2 focus:ring-lamp-400"
          />
          <button onClick={() => void add()} className="w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900">
            Add to my porch
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-6 flex items-center gap-2 rounded-xl bg-dusk-700 px-4 py-3 text-cream/80"
        >
          <UserPlus size={18} /> Add someone
        </button>
      )}
    </div>
  );
}
