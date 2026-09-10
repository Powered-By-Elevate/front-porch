import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Must match the value seeded into app_config.phone_pepper, because the
// device hashes the address book and the server hashes the user's own
// number, and the two have to meet. Publishable by design: it breaks
// precomputed tables only (PRD law 7 says this honestly).
const PEPPER =
  (import.meta.env.VITE_PHONE_PEPPER as string | undefined) ??
  'front-porch-v1-pepper';

export function toE164(raw: string, defaultCountry: 'US' = 'US'): string | null {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  return parsed && parsed.isValid() ? parsed.number : null;
}

export async function hashPhone(e164: string): Promise<string> {
  const bytes = new TextEncoder().encode(PEPPER + e164);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
