import { Atmosphere } from './Atmosphere';
import { Clouds } from './Clouds';
import { Rain } from './Rain';

/**
 * Visual environment layer for storms. It READS the global wind only and never writes to the
 * simulation, so turning it off (or changing it) cannot alter physics or damage results.
 */
export function TyphoonEnvironment() {
  return (
    <>
      <Atmosphere />
      <Clouds />
      <Rain />
    </>
  );
}
