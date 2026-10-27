import { create } from 'zustand';
import type { I18nMessage } from '@/i18n/i18n';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';
export interface Toast { id: number; tone: ToastTone; message: I18nMessage; detail?: string }

interface ToastState {
  toasts: Toast[];
  push: (tone: ToastTone, message: I18nMessage, detail?: string) => void;
  dismiss: (id: number) => void;
}

let next = 1;
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, message, detail) => {
    const id = next++;
    set({ toasts: [...get().toasts, { id, tone, message, detail }].slice(-4) });
    setTimeout(() => get().dismiss(id), tone === 'error' ? 6000 : 3200);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (tone: ToastTone, message: I18nMessage, detail?: string) =>
  useToastStore.getState().push(tone, message, detail);
