import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { Segmented } from '@/ui/common/Segmented';

/** Editor ↔ Simulation mode switch. Simulation mode is wired up in Phase 3. */
export function ModeSwitch() {
  const t = useT();
  const mode = useEditorStore((s) => s.mode);
  return (
    <Segmented
      value={mode}
      onChange={() => {}}
      options={[
        { value: 'editor', label: t('mode.editor') },
        { value: 'simulation', label: t('mode.simulation'), tone: 'sim', disabled: true },
      ]}
    />
  );
}
