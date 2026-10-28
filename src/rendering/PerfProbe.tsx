import { useFrame } from '@react-three/fiber';

/** Renderer counters accumulated by PerfProbe and drained by the dev performance HUD. */
export const rendererStats = {
  frames: 0,
  frameMs: 0,
  maxFrameMs: 0,
  drawCalls: 0,
  triangles: 0,
  reset() {
    this.frames = 0;
    this.frameMs = 0;
    this.maxFrameMs = 0;
    this.drawCalls = 0;
    this.triangles = 0;
  },
};

/**
 * Samples frame time and renderer counters every frame (mounted only while the HUD is open).
 * `gl.info` still holds the previous frame's totals here — including the shadow pass — because
 * three.js resets it at the start of each render.
 */
export function PerfProbe() {
  useFrame(({ gl }, dt) => {
    const ms = dt * 1000;
    rendererStats.frames++;
    rendererStats.frameMs += ms;
    if (ms > rendererStats.maxFrameMs) rendererStats.maxFrameMs = ms;
    rendererStats.drawCalls += gl.info.render.calls;
    rendererStats.triangles += gl.info.render.triangles;
  });
  return null;
}
