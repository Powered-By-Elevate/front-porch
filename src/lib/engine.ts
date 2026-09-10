import { sb } from './supabase';

export type OpenConnection = { id: string; other_hash: string; ends_at: string };

const CODES = [
  'light_cap', 'underage', 'no_phone_identity', 'no_profile', 'self_light', 'blocked_target',
  'no_connection', 'bad_windows', 'bad_slot', 'slot_outside_overlap',
  'plan_confirmed', 'own_proposal', 'no_proposal', 'no_availability',
];

export async function rpc(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) {
    for (const code of CODES) {
      if (error.message.includes(code)) throw new Error(code);
    }
    throw new Error(error.message);
  }
  return data;
}

export const ensureProfile = (dobIso: string) => rpc('ensure_profile', { p_dob: dobIso });
export const setLight = (hash: string) => rpc('set_light', { p_target_hash: hash });
export const unsetLight = (hash: string) => rpc('unset_light', { p_target_hash: hash });
export const setHideMe = (hide: boolean) => rpc('set_hide_me', { p_hide: hide });
export const blockHash = (hash: string) => rpc('block_hash', { p_hash: hash });
export const purgeMe = () => rpc('purge_me');

export async function myLights(): Promise<string[]> {
  const { data, error } = await sb().from('lights').select('target_hash');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.target_hash as string);
}

export async function whoIsOn(hashes: string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = (await rpc('sync_contacts', { p_hashes: hashes })) as { on_hash: string }[] | null;
  return (rows ?? []).map((r) => r.on_hash);
}

export async function myConnections(): Promise<OpenConnection[]> {
  return ((await rpc('my_connections')) as OpenConnection[] | null) ?? [];
}
