import { useMemo } from 'react';
import { useCommandSession } from '@/ui/Command/commandSession';
import { commandPins, type CommandPins } from './previewModel';

/** The disaster pins commands ask the pin layer to show (previewModel.ts `commandPins`), from the command session. */
export function useCommandPins(): CommandPins {
  const preview = useCommandSession((s) => s.plan?.preview ?? null);
  const feedback = useCommandSession((s) => s.feedback);
  const hover = useCommandSession((s) => s.hover);
  return useMemo(() => commandPins(preview, feedback, hover), [preview, feedback, hover]);
}
