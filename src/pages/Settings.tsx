import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { sb, supabase } from '../lib/supabase';
import { blockHash, purgeMe, setHideMe } from '../lib/engine';
import { usePorch } from '../store';

export function Settings() {
  const { people, removePerson } = usePorch();
  const [hide, setHide] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void sb()
      .from('profiles')
      .select('hide_me')
      .maybeSingle()
      .then(({ data }) => {
        if (data) setHide(Boolean(data.hide_me));
      });
  }, []);

  const toggleHide = async () => {
    const next = !hide;
    setHide(next);
    try {
      await setHideMe(next);
    } catch {
      setHide(!next);
    }
  };

  const block = async (hash: string) => {
    try {
      await blockHash(hash);
      removePerson(hash);
      setMsg('Blocked. You are invisible to each other everywhere.');
    } catch {
      setMsg('Block did not stick. Try again.');
    }
  };

  const deleteAccount = async () => {
    try {
      await purgeMe();
      await supabase?.auth.signOut();
    } catch {
      setMsg('Delete did not finish. Try again.');
    }
  };

  return (
    <div className="mx-auto max-w-md px-5 py-10">
      <Link to="/" aria-label="Back" className="text-cream/60">
        <ChevronLeft size={22} />
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Settings</h1>

      <section className="mt-8 rounded-2xl bg-dusk-700 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Hide me</p>
            <p className="text-sm text-cream/60">
              Your contacts stop seeing you as on Front Porch. Lights still
              work exactly the same.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={hide}
            onClick={() => void toggleHide()}
            className={
              'h-8 w-14 rounded-full p-1 transition-colors ' +
              (hide ? 'bg-lamp-400' : 'bg-dusk-600')
            }
          >
            <span
              className={
                'block h-6 w-6 rounded-full bg-cream transition-transform ' +
                (hide ? 'translate-x-6' : '')
              }
            />
          </button>
        </div>
      </section>

      <section className="mt-4 rounded-2xl bg-dusk-700 p-4">
        <p className="font-medium">Block someone</p>
        <p className="text-sm text-cream/60">
          Absolute and quiet: no future match, any open connection dissolves,
          nobody is told.
        </p>
        <ul className="mt-3 space-y-2">
          {people.map((p) => (
            <li key={p.hash} className="flex items-center justify-between">
              <span>{p.name}</span>
              <button onClick={() => void block(p.hash)} className="text-sm text-red-300">
                Block
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 rounded-2xl bg-dusk-700 p-4">
        <p className="font-medium">Delete my account</p>
        <p className="text-sm text-cream/60">
          Lights, connections, and your profile are purged for real.
        </p>
        {confirmDelete ? (
          <button onClick={() => void deleteAccount()} className="mt-3 w-full rounded-xl bg-red-400 px-4 py-3 font-semibold text-dusk-900">
            Yes, delete everything
          </button>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="mt-3 text-sm text-red-300">
            Delete...
          </button>
        )}
      </section>

      {msg && <p className="mt-4 text-sm text-lamp-300">{msg}</p>}
    </div>
  );
}
