let counter = 0;

export function createId(prefix = 'obj'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  counter = (counter + 1) % 1e6;
  return `${prefix}_${rand}${counter.toString(36)}`;
}
