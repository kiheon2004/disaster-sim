import { AppLayout } from './AppLayout';
import { useEditorHotkeys } from './hotkeys';
import { bootstrapWorld } from './actions';
import { Toaster } from '@/ui/common/Toaster';

bootstrapWorld();

export function App() {
  useEditorHotkeys();
  return (
    <>
      <AppLayout />
      <Toaster />
    </>
  );
}
