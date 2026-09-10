import { useState } from 'react';
import { configured, sb } from '../lib/supabase';
import { toE164 } from '../lib/phone';

export function Welcome() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');

  if (!configured()) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-3xl font-semibold">Front Porch</h1>
        <p className="mt-4 text-cream/70">
          The scaffold is running, but no backend is wired yet. Copy
          .env.example to .env, fill the Supabase values, and restart. The
          runbook in README.md walks the whole setup.
        </p>
      </div>
    );
  }

  const sendCode = async () => {
    setErr('');
    const e164 = toE164(phone);
    if (!e164) {
      setErr('That number did not parse. Use your full number.');
      return;
    }
    const { error } = await sb().auth.signInWithOtp({ phone: e164 });
    if (error) {
      setErr(error.message);
      return;
    }
    setSent(e164);
    setStage('code');
  };

  const verify = async () => {
    setErr('');
    const { error } = await sb().auth.verifyOtp({ phone: sent, token: code, type: 'sms' });
    if (error) setErr(error.message);
  };

  return (
    <div className="mx-auto max-w-md px-5 py-16">
      <h1 className="text-3xl font-semibold">Front Porch</h1>
      <p className="mt-2 text-cream/70">Leave your light on.</p>

      {stage === 'phone' ? (
        <div className="mt-10 space-y-3">
          <label className="block text-sm text-cream/70" htmlFor="phone">
            Your phone number
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-xl bg-dusk-700 px-4 py-3 outline-none focus:ring-2 focus:ring-lamp-400"
            placeholder="(555) 555-0100"
          />
          <button
            onClick={() => void sendCode()}
            className="w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
          >
            Send my code
          </button>
        </div>
      ) : (
        <div className="mt-10 space-y-3">
          <label className="block text-sm text-cream/70" htmlFor="code">
            The code we texted you
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-xl bg-dusk-700 px-4 py-3 tracking-widest outline-none focus:ring-2 focus:ring-lamp-400"
            placeholder="123456"
          />
          <button
            onClick={() => void verify()}
            className="w-full rounded-xl bg-lamp-400 px-4 py-3 font-semibold text-dusk-900"
          >
            Come on in
          </button>
        </div>
      )}

      {err && <p className="mt-4 text-sm text-red-300">{err}</p>}
    </div>
  );
}
