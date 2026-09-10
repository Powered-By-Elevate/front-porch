# Front Porch: Leave Your Light On

Turn on a light for someone in your contacts. They never find out, unless
their light is on for you too. Then both of you hear about it in the same
moment, and three doors open: Text, Call, Make Plans. 48 hours later both
lights go out, and only both of you choosing again can ring it twice.

**The brain and the law live in the OS:** `os-vault/wiki/projects/front-porch.md`
(the privacy constitution, the settled mechanics, the age architecture,
every ruling with Matt's words). This README is only the build.

## Status: scaffold (2026-09-09)

Built and typechecked, not yet run against a live backend, because the
Supabase project does not exist yet. What is real:

- **The engine** (`supabase/migrations/0001_engine.sql`): the whole product.
  Lights as rows (existence = on, real 10 seconds after flip), the lock a
  minute-tick computes when both lights are on and real, the randomized
  2 to 30 minute reveal, the 48-hour window, expiry that forces both
  lights off, blocks that dissolve quietly, real deletes. RLS makes a
  light unreadable by anyone but its owner and makes a locked, unrevealed
  connection invisible even to its two participants.
- **The app shell**: phone OTP sign-in, the neutral DOB gate (18+ enforced
  server-side too, failed gate remembered on device), the porch list with
  the instant light switch, the reveal screen with the blessed copy and
  the three doors, settings (hide me, block, delete account).
- **The rails**: Capacitor config carrying the Sunday's Supper shell laws
  (contentInset never, scrollEnabled false, zoomEnabled false, 16px input
  floor), Codemagic iOS workflow on the house pattern.
- **Make Plans** (built 2026-09-10, the first stub to land): the whole
  third door. Server side (`migrations/..._0002_make_plans.sql`): each
  person's free windows land as a multirange only its owner can ever
  read, the other person only sees the computed overlap, a proposed slot
  must sit inside the live overlap and the server re-checks it, only the
  non-proposer can confirm (a plan is two yeses, same shape as the
  lights), and there is no decline anywhere because a counter-proposal
  replaces rejection. Free/busy scrubs by trigger the moment a
  connection expires, on every path. Client side (`src/pages/Plans.tsx`):
  a 14-day day-by-daypart grid, a small spread of concrete times
  rotating dayparts across days, and a confirmed plan becomes an .ics
  each device adds to its own calendar, so the plan outlives the 48
  hours. Smoke: `supabase/tests/plans_smoke.sql`, ALL PLANS CHECKS
  PASSED.

Deliberately stubbed, in order of build priority:

1. **Push delivery**: the tick enqueues into `push_queue`. A scheduled
   edge function draining it to APNs still needs writing, plus the
   Capacitor push registration handshake. Pushes are nameless by
   architecture: the server never knows names, so the name renders in-app.
2. **Device contacts import** (`src/lib/contacts.ts`): install
   `@capacitor-community/contacts` at native-wrap time. Manual add works
   today and stays as the permission-denied fallback.
3. **Device calendar pre-fill** (`src/lib/calendar.ts`): a calendar
   plugin (EventKit underneath) at native-wrap time, so the Make Plans
   grid starts pre-filled from real free/busy. The hand-filled grid
   works today and stays as the permission-denied fallback. Same moment:
   route add-to-calendar through the share sheet, WKWebView has no
   downloads.
4. **Delete-account edge function** removing the auth user itself, on the
   Sunday's Supper pattern (App Review 5.1.1(v) requires it).

## Runbook: from scaffold to phone

1. **Supabase project** (supabase.com, free tier): create it, then in the
   SQL editor run the files in `supabase/migrations/` in order (0001,
   then 0002). Enable the `pg_cron` extension first if the create line
   complains.
2. **Phone auth needs an SMS provider.** Supabase Auth → Providers →
   Phone: wire Twilio (or MessageBird). Real cost, roughly five cents per
   verification text. Without this step sign-in cannot work at all.
3. **Env**: copy `.env.example` to `.env`, fill the project URL and anon
   key. Then `npm install` and `npm run dev` gives the whole flow in a
   browser.
4. **Native wrap** (Mac): `npx cap add ios`, then
   `npm run build && npx cap sync ios`, open in Xcode once to set the
   team. Add the contacts plugin here.
5. **Codemagic**: add the repo, create the ASC integration named
   `front-porch-asc`, add `CERTIFICATE_PRIVATE_KEY` to the
   `appstore_credentials` group, fill the two `VITE_` vars in
   `codemagic.yaml`. The workflow registers the bundle id and creates
   signing on first run, same as Sunday's Supper.

## The bundle id is not the app's name, on purpose

`com.poweredbyelevate.both` (the old working name). Matt accepted the
trademark risk on "Front Porch" with rename-if-challenged as the fallback,
and a bundle id is permanent after the first upload while the display name
renames freely. Keep the name out of identifiers, always.

## Where this repo came from

The scaffold was built inside agentic-os (`apps/front-porch/`) on
2026-09-09, because a cloud session cannot create a repository on a user
account. Matt created this repo on 2026-09-10 and the scaffold graduated
here the same day, wholesale. The product brain stays in the OS, and
rulings land there first.
