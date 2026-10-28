import { useEffect, useState } from 'react';
import { rendererStats } from '@/rendering/PerfProbe';
import { getActiveAdapter } from '@/rendering/sim/renderStats';
import { simProfiler, type SimProfileSnapshot } from '@/simulation/profiling/SimProfiler';
import { simulationController } from '@/simulation/SimulationController';
import { useWorldStore } from '@/world/worldStore';
import { terrainStats } from '@/terrain/terrainStats';

const REFRESH_MS = 250;

interface Row {
  fps: number;
  frameMs: number;
  maxFrameMs: number;
  drawCalls: number;
  triangles: number;
  objects: number;
  instances: number | null;
  heapMB: number | null;
  sim: SimProfileSnapshot | null;
  terrainQueriesPerStep: number | null;
  terrainEdit: string;
  terrainBuildMs: number | null;
}

function read(): Row {
  const n = Math.max(1, rendererStats.frames);
  const frameMs = rendererStats.frameMs / n;
  const rt = simulationController.getRuntime();
  const running = simulationController.getStatus() === 'running';
  const sim = simProfiler.snapshot();
  const adapter = getActiveAdapter();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const row: Row = {
    fps: rendererStats.frames ? 1000 / frameMs : 0,
    frameMs,
    maxFrameMs: rendererStats.maxFrameMs,
    drawCalls: rendererStats.drawCalls / n,
    triangles: rendererStats.triangles / n,
    objects: rt ? rt.entities.size : Object.keys(useWorldStore.getState().doc.objects).length,
    instances: adapter ? adapter.stats().instances : null,
    heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
    sim: running ? sim : null,
    terrainQueriesPerStep: null,
    terrainEdit: terrainStats.dabs || terrainStats.meshUpdates
      ? `dab ${(terrainStats.dabMs / Math.max(1, terrainStats.dabs)).toFixed(2)} · mesh ${(terrainStats.meshMs / Math.max(1, terrainStats.meshUpdates)).toFixed(2)} ms`
      : '—',
    terrainBuildMs: rt ? simulationController.terrainBuildMs : null,
  };
  // Terrain height queries made by the simulation (wind profile, particles, …) per fixed step.
  const terrain = rt ? simulationController.getEnvironment().terrain : null;
  if (terrain) {
    if (running && sim.steps) row.terrainQueriesPerStep = terrain.queries / sim.steps;
    terrain.queries = 0;
  }
  terrainStats.reset();
  rendererStats.reset();
  return row;
}

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/**
 * Developer performance HUD: frame rate, frame time, the cost of each simulation stage
 * (physics, wind field, damage, total simulation tick — ms per rendered frame) and renderer
 * counters. Hidden by default; enabling it also enables the simulation profiler.
 */
export function PerfHud() {
  const [row, setRow] = useState<Row | null>(null);
  useEffect(() => {
    simProfiler.enabled = true;
    simProfiler.snapshot();
    rendererStats.reset();
    const id = setInterval(() => setRow(read()), REFRESH_MS);
    return () => {
      clearInterval(id);
      simProfiler.enabled = false;
    };
  }, []);
  if (!row) return null;
  const s = row.sim;
  const lines: [string, string, string?][] = [
    ['FPS', f1(row.fps)],
    ['Frame', `${f1(row.frameMs)} ms`, `max ${f1(row.maxFrameMs)}`],
    ['Simulation', s ? `${f2(s.tickMs)} ms` : '—', s ? `${f2(s.stepsPerTick)} steps · ${f2(s.simSpeed)}×` : 'paused'],
    ['Physics', s ? `${f2(s.physicsMs)} ms` : '—'],
    ['Wind field', s ? `${f2(s.windMs)} ms` : '—', s ? `${Math.round(s.windSamplesPerStep)} samples/step` : undefined],
    ['Damage', s ? `${f2(s.damageMs)} ms` : '—', 'incl. facade wind'],
    ['Draw calls', String(Math.round(row.drawCalls)), 'incl. shadows'],
    ['Triangles', `${(row.triangles / 1000).toFixed(0)}k`],
    ['Objects', String(row.objects), row.instances !== null ? `${row.instances} instances` : undefined],
    ['Terrain q', row.terrainQueriesPerStep !== null ? `${Math.round(row.terrainQueriesPerStep)}/step` : '—', row.terrainBuildMs !== null ? `collider ${f1(row.terrainBuildMs)} ms` : undefined],
    ['Terrain upd', row.terrainEdit],
  ];
  if (row.heapMB !== null) lines.push(['JS heap', `${row.heapMB.toFixed(0)} MB`]);
  return (
    <div
      className="mono"
      data-testid="perf-hud"
      style={{
        padding: '8px 10px', borderRadius: 8, background: 'rgba(11,15,20,0.82)', border: '1px solid rgba(255,255,255,0.12)',
        fontSize: 11, lineHeight: 1.5, minWidth: 230, pointerEvents: 'none',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-2)' }}>PERF · Shift+P</div>
      {lines.map(([k, v, note]) => (
        <div key={k} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--text-2)', width: 74 }}>{k}</span>
          <span style={{ fontWeight: 600 }}>{v}</span>
          {note && <span style={{ color: 'var(--text-2)', marginLeft: 'auto' }}>{note}</span>}
        </div>
      ))}
    </div>
  );
}
