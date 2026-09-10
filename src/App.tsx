import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useSession } from './hooks/useSession';
import { registerPushToken } from './lib/engine';
import { devicePushToken } from './lib/push';
import { configured, sb } from './lib/supabase';
import { usePorch } from './store';
import { Welcome } from './pages/Welcome';
import { BirthDate } from './pages/BirthDate';
import { Porch } from './pages/Porch';
import { Reveal } from './pages/Reveal';
import { Plans } from './pages/Plans';
import { Settings } from './pages/Settings';

export default function App() {
  const { session, loading } = useSession();
  const { profileReady, setProfileReady, loadPeople } = usePorch();
  const [checkedProfile, setCheckedProfile] = useState(false);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  useEffect(() => {
    if (!session || !configured()) {
      setCheckedProfile(true);
      return;
    }
    void sb()
      .from('profiles')
      .select('id')
      .maybeSingle()
      .then(({ data }) => {
        setProfileReady(Boolean(data));
        setCheckedProfile(true);
      });
  }, [session, setProfileReady]);

  // Register the device for the nameless reveal push. A stub until the
  // native wrap (push.ts), so this quietly no-ops on the web.
  useEffect(() => {
    if (!session || !profileReady || !configured()) return;
    void devicePushToken().then((token) => {
      if (token) void registerPushToken(token).catch(() => undefined);
    });
  }, [session, profileReady]);

  if (loading || !checkedProfile) return null;
  if (!session) return <Welcome />;
  if (!profileReady) return <BirthDate />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Porch />} />
        <Route path="/reveal/:id" element={<Reveal />} />
        <Route path="/plans/:id" element={<Plans />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}
