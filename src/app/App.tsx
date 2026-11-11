import { AppLayout } from './AppLayout';
import { useEditorHotkeys } from './hotkeys';
import { bootstrapWorld } from './actions';
import { installInputPolicy } from './inputPolicy';
import { Toaster } from '@/ui/common/Toaster';
import { ResultsPanel } from '@/ui/Results/ResultsPanel';
import { ComparisonDialog } from '@/ui/Results/ComparisonDialog';

bootstrapWorld();
installInputPolicy();

export function App() {
  useEditorHotkeys();
  return (
    <>
      <AppLayout />
      <Toaster />
      <ResultsPanel />
      <ComparisonDialog />
    </>
  );
}
