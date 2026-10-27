import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ko, type MessageKey } from './locales/ko';
import { en } from './locales/en';

export type Locale = 'ko' | 'en';
export type { MessageKey };
export type TranslateParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: TranslateParams) => string;

/** A message that can be stored in data (logs, parse errors) and translated at render time. */
export interface I18nMessage {
  key: MessageKey;
  params?: TranslateParams;
}

export const LOCALES: { id: Locale; label: string; short: string }[] = [
  { id: 'ko', label: '한국어', short: 'KO' },
  { id: 'en', label: 'English', short: 'EN' },
];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { ko, en };

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggle: () => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set, get) => ({
      locale: 'ko', // Korean is the default regardless of the browser language.
      setLocale: (locale) => set({ locale }),
      toggle: () => set({ locale: get().locale === 'ko' ? 'en' : 'ko' }),
    }),
    { name: 'ds.locale' },
  ),
);

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const template = dictionaries[locale][key] ?? dictionaries.ko[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

/** Non-reactive translation (for use outside React). */
export const t: TFunction = (key, params) => translate(useLocaleStore.getState().locale, key, params);

/** Reactive translation hook: components re-render when the locale changes. */
export function useT(): TFunction {
  const locale = useLocaleStore((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

export function translateMessage(locale: Locale, msg: I18nMessage): string {
  return translate(locale, msg.key, msg.params);
}

export function isMessageKey(key: string): key is MessageKey {
  return key in ko;
}

// Keep <html lang> in sync for accessibility and font selection.
if (typeof document !== 'undefined') {
  const apply = (l: Locale) => document.documentElement.setAttribute('lang', l);
  apply(useLocaleStore.getState().locale);
  useLocaleStore.subscribe((s) => apply(s.locale));
}
