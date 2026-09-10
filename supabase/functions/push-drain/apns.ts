// APNs plumbing with no runtime dependencies: WebCrypto + fetch shapes
// only, no Deno globals, so Node can unit-test the math the container
// cannot exercise against Apple. index.ts owns the Deno half.

const enc = new TextEncoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const b64urlJson = (o: unknown) => b64urlBytes(enc.encode(JSON.stringify(o)));

function pemToPkcs8(p8: string): Uint8Array {
  const body = p8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Apple wants ES256 over {iss: teamId, iat} with the key id in the
// header, reused 20-60 minutes. WebCrypto's ECDSA signature is already
// the raw r||s form JWS wants, no DER conversion needed.
export async function apnsJwt(p8Pem: string, keyId: string, teamId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(p8Pem).buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signing =
    b64urlJson({ alg: 'ES256', kid: keyId }) +
    '.' +
    b64urlJson({ iss: teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signing),
  );
  return signing + '.' + b64urlBytes(new Uint8Array(sig));
}

export const apnsHost = (env: string): string =>
  env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

// The queue payload is {title, body} and nothing else, nameless by
// architecture (PRD §4.4). content-available stays off: these are plain
// alert pushes.
export function alertBody(payload: { title?: string; body?: string }): string {
  return JSON.stringify({
    aps: { alert: { title: payload.title ?? '', body: payload.body ?? '' }, sound: 'default' },
  });
}

export function apnsHeaders(jwt: string, topic: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
  };
}

export type ApnsOutcome = 'ok' | 'gone' | 'auth' | 'retry' | 'dead';

// gone: this token will never work again, drop it. auth: our JWT is the
// problem, stop the run and let the next tick retry with a fresh one.
// retry: transient on Apple's side, leave the claim to expire. dead: the
// request itself is wrong, mark the row so it never loops.
export function classifyApns(status: number, reason: string | undefined): ApnsOutcome {
  if (status === 200) return 'ok';
  if (status === 410) return 'gone';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))
    return 'gone';
  if (
    status === 403 &&
    (reason === 'ExpiredProviderToken' ||
      reason === 'InvalidProviderToken' ||
      reason === 'MissingProviderToken')
  )
    return 'auth';
  if (status === 429 || status >= 500) return 'retry';
  return 'dead';
}
