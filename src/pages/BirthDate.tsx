import { useEffect, useState } from 'react';
import { Preferences } from '@capacitor/preferences';
import { ensureProfile } from '../lib/engine';
import { usePorch } from '../store';

const UNDERAGE_KEY = 'fp-underage';

// Neutral by design (PRD §6): nothing on this screen hints at what any
// age unlocks, and a failed gate is remembered on the device so there is
// no retry loophole. The server enforces the same wall in ensure_profile.
export function BirthDate() {
  const [dob, setDob] = useState('');
  const [err, setErr] = useState('');
  const [waitlisted, setWaitlisted] = useState(false);
  const setProfileReady = usePorch((s) => s.setProfileReady);

  useEffect(() => {
    void Preferences.get({ key: UNDERAGE_KEY }).then(({ value }) => {
      if (value) setWaitlisted(true);
    });
  }, []);

  if (waitlisted) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-2xl font-semibold">Not quite yet</h1>
        <p className="mt-3 text-cream/70">
          Front Porch is 18 and up for now. We are saving you a seat on the
          steps.
        </p>
      </div>
    );
  }

  const submit = async () => {
    setErr('');
    if (!dob) return;
    try {
      await ensureProfile(dob);
      setProfileReady(true);
    } catch (e) {
      if (e instanceof Error && e.message === 'underage') {
        await Preferences.set({ key: UNDERAGE_KEY, value: '1' });
        setWaitlisted(true);
      } else {
        setErr(e instanceof Error ? e.message : 'Something went sideways.');
      }
    }
  };

  return (
    <div className="mx-auto max-w-md px-5 py-16">
      <h1 className="text-2xl font-semibold">When were you born?</h1>
      <div className="mt-8 space-y-3">
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="w-full rounded-xl bg-dusk-700 px-4 py-3 outline-none focus:ring-2 focus:ring-lamp-400"
        />
        <button
          onClick={() => void submit()}
          className="w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
        >
          Continue
        </button>
      </div>
      {err && <p className="mt-4 text-sm text-red-300">{err}</p>}
    </div>
  );
}
