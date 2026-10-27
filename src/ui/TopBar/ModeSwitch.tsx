import { useT } from '@/i18n/i18n';
import { useEditorStore, type AppMode } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { enterSimulation, exitSimulation } from '@/app/actions';
import { Segmented } from '@/ui/common/Segmented';

/** Editor ↔ Simulation. Entering snapshots the world; leaving discards the runtime (full restore). */
export function ModeSwitch() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  const loading = useSimStore((s) => s.status === 'loading');
  return (
    <Segmented<AppMode>
      value={mode}
      onChange={(m) => (m === 'simulation' ? void enterSimulation() : exitSimulation())}
      options={[
        { value: 'editor', label: t('mode.editor'), title: t('mode.editor.title'), disabled: loading },
        { value: 'simulation', label: t('mode.simulation'), tone: 'sim', title: t('mode.simulation.title'), disabled: loading },
      ]}
    />
  );
}
