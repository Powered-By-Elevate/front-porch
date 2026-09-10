import { create } from 'zustand';
import { Preferences } from '@capacitor/preferences';

// A person on your porch. Name and number live ONLY here on the device
// (PRD law 7); the server ever sees just the hash.
export type Person = { name: string; number: string; hash: string };

type PorchState = {
  people: Person[];
  lights: string[];
  onFP: string[];
  profileReady: boolean;
  setProfileReady: (v: boolean) => void;
  setLights: (l: string[]) => void;
  setOnFP: (l: string[]) => void;
  addPerson: (p: Person) => void;
  removePerson: (hash: string) => void;
  loadPeople: () => Promise<void>;
};

const KEY = 'fp-people';

async function persist(people: Person[]) {
  await Preferences.set({ key: KEY, value: JSON.stringify(people) });
}

export const usePorch = create<PorchState>((set, get) => ({
  people: [],
  lights: [],
  onFP: [],
  profileReady: false,
  setProfileReady: (v) => set({ profileReady: v }),
  setLights: (lights) => set({ lights }),
  setOnFP: (onFP) => set({ onFP }),
  addPerson: (p) => {
    if (get().people.some((x) => x.hash === p.hash)) return;
    const people = [...get().people, p];
    set({ people });
    void persist(people);
  },
  removePerson: (hash) => {
    const people = get().people.filter((x) => x.hash !== hash);
    set({ people });
    void persist(people);
  },
  loadPeople: async () => {
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (value) set({ people: JSON.parse(value) as Person[] });
    } catch {
      // First run or unreadable storage: an empty porch is a valid porch.
    }
  },
}));
