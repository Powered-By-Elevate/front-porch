import { Lamp } from 'lucide-react';

// The whole product in one control. Instant on, instant off, no pending
// state, no confirmation, no countdown (PRD §4). The 10-second rule and
// everything after it live server-side and are never surfaced here.
export function Light({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Turn the light off' : 'Leave the light on'}
      onClick={onToggle}
      className={
        'flex h-11 w-11 items-center justify-center rounded-full transition-colors ' +
        (on
          ? 'bg-lamp-400 text-dusk-900 shadow-[0_0_18px_4px_rgba(245,179,76,0.45)]'
          : 'bg-dusk-600 text-cream/40')
      }
    >
      <Lamp size={22} />
    </button>
  );
}
