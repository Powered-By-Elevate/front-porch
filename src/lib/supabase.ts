import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Null when env is unfilled so the scaffold runs (and demos its screens)
// before the Supabase project exists. Every caller goes through sb().
export const supabase: SupabaseClient | null =
  url && anon ? createClient(url, anon) : null;

export function configured(): boolean {
  return supabase !== null;
}

export function sb(): SupabaseClient {
  if (!supabase) throw new Error('unconfigured');
  return supabase;
}
