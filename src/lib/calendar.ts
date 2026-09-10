// Device calendar free/busy arrives with the native wrap: add a calendar
// plugin (EventKit underneath) alongside `npx cap add ios`, ask
// permission, read busy blocks for the next 14 days, and return the gaps
// here as windows. The grid in Plans.tsx then starts pre-filled and the
// person edits from there, because a calendar says busy, not willing.
// Until then this returns null and the grid is filled by hand, which is
// also the permanent fallback for anyone who denies calendar permission.
// Free/busy only, per PRD §5: event details never leave the device
// either, because they are never even read into the app.
export type FreeWindow = { s: string; e: string };

export async function deviceFreeWindows(): Promise<FreeWindow[] | null> {
  return null;
}
