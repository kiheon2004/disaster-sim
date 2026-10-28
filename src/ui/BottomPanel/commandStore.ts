import { create } from 'zustand';
import type { ParseResult } from '@/commands/CommandParser';

export interface CommandEntry {
  id: number;
  input: string;
  result: ParseResult;
  executed: boolean;
}

interface CommandState {
  entries: CommandEntry[];
  /** Previously submitted inputs for ↑/↓ recall. */
  inputs: string[];
  add: (e: Omit<CommandEntry, 'id'>) => void;
  clear: () => void;
}

let nextId = 1;
export const useCommandStore = create<CommandState>((set, get) => ({
  entries: [],
  inputs: [],
  add: (e) =>
    set({
      entries: [...get().entries, { ...e, id: nextId++ }].slice(-60),
      inputs: [...get().inputs.filter((i) => i !== e.input), e.input].slice(-50),
    }),
  clear: () => set({ entries: [] }),
}));
