import type { SVGProps } from 'react';

/** Minimal stroke icon set drawn in code (no external assets). */
const paths = {
  building: 'M4 21V5l7-2v18M11 21h9V9l-9-3M7 8h1M7 12h1M7 16h1M14 12h2M14 16h2',
  tree: 'M12 22v-6M12 16c-4 0-7-2.5-7-6 0-3 2.6-6 7-8 4.4 2 7 5 7 8 0 3.5-3 6-7 6z',
  conifer: 'M12 22v-4M12 2l-6 8h3l-4 6h14l-4-6h3z',
  car: 'M3 16v-4l2-5h14l2 5v4M3 16h18M3 16v2h3v-2M18 16v2h3v-2M6 12h12',
  truck: 'M2 16V6h11v10M13 9h5l3 4v3H2M6 18a2 2 0 100-.01M17 18a2 2 0 100-.01',
  human: 'M12 5a2 2 0 100-.01M12 8v7M12 15l-3 6M12 15l3 6M7 10h10',
  streetLight: 'M8 22h6M11 22V4h6M17 4v2M15 7h4',
  sign: 'M12 22v-9M4 3h16v10H4z',
  wall: 'M3 7h18M3 12h18M3 17h18M3 4v16h18V4M8 7v5M14 12v5M16 7v5M9 17v3',
  road: 'M6 21L9 3M18 21L15 3M12 5v2M12 11v2M12 17v2',
  cursor: 'M5 3l14 8-6 2-2 6z',
  move: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  rotate: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  scale: 'M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7',
  folder: 'M3 6h6l2 2h10v11H3z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM14 4h4v16h-4z',
  reset: 'M4 12a8 8 0 108-8 8.5 8.5 0 00-6 2.5L4 9M4 4v5h5',
  wind: 'M3 8h11a3 3 0 10-3-3M3 12h16a3 3 0 11-3 3M3 16h8',
  help: 'M12 22a10 10 0 110-20 10 10 0 010 20zM9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 4M12 17h.01',
  globe: 'M12 22a10 10 0 110-20 10 10 0 010 20zM2 12h20M12 2c3 3 4 6.5 4 10s-1 7-4 10c-3-3-4-6.5-4-10s1-7 4-10z',
  focus: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M12 12h.01',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.3 4.1M6.6 6.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004.4-1.1M9.9 9.9a3 3 0 004.2 4.2',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.3 2h12.4a1.5 1.5 0 001.3-2L14 9V3M7 15h10',
  magnet: 'M6 3v8a6 6 0 0012 0V3h-4v8a2 2 0 01-4 0V3zM6 7h4M14 7h4',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  terrain: 'M2 20l7-11 4 6 3-4 6 9z',
  raise: 'M12 19V6M7 11l5-5 5 5M4 21h16',
  lower: 'M12 4v13M7 12l5 5 5-5M4 3h16',
  flatten: 'M3 13h18M3 18h18M7 8l5-4 5 4',
  smooth: 'M3 15c3-6 6-6 9 0s6 6 9 0',
  brush: 'M14 4l6 6-8 8-6-6zM6 12l-3 3c-1 2 0 5 3 5 2 0 3-1 3-3l3-3',
  probe: 'M12 2v8M12 22a5 5 0 100-10 5 5 0 000 10zM12 17h.01',
  quake: 'M2 12h3l2-6 3 12 3-9 2 5 2-2h5',
  volcano: 'M3 20l6-11h2l1.5 3 1.5-3h2l5 11zM10 5c0-1.5 1-2.5 2-2.5S14 3.5 14 5M8.5 6.5C8 5 9 4 10 4',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2.5 1.5-4 2.5-5 0 2 1 3 2 3.5C11 9 11 6 12 3zM12 21a2 2 0 01-2-2c0-1.2 1-2 2-3.5 1 1.5 2 2.3 2 3.5a2 2 0 01-2 2z',
  heat: 'M10 13.5V5a2 2 0 014 0v8.5a4 4 0 11-4 0zM12 17a1 1 0 100-.01M12 8v8.5M17 5h3M17 9h3',
  water: 'M12 3c3 4.5 6 7.6 6 11a6 6 0 01-12 0c0-3.4 3-6.5 6-11zM9 15a3 3 0 003 3',
  rain: 'M7 14a4 4 0 01-.5-7.97A5.5 5.5 0 0117 7a3.5 3.5 0 01.5 7H7zM8 17l-1 3M12 17l-1 3M16 17l-1 3',
  soil: 'M3 7h18M3 12h18M3 17h18M6 9.5h.01M14 9.5h.01M10 14.5h.01M18 14.5h.01M7 19.5h.01',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  // Phase 16 (Creative Build Mode)
  place: 'M12 21s-6-5.5-6-10a6 6 0 0112 0c0 4.5-6 10-6 10zM12 13a2 2 0 100-4 2 2 0 000 4z',
  scatter: 'M5 6h.01M10 4h.01M16 6h.01M7 11h.01M13 10h.01M19 11h.01M5 16h.01M11 15h.01M17 16h.01M9 20h.01M15 20h.01',
  line: 'M4 19L20 5M4 19h.01M9.3 14.3h.01M14.7 9.7h.01M20 5h.01',
  area: 'M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8M9 9h6v6H9z',
  paste: 'M9 4h6v3H9zM8 5H5v16h14V5h-3M9 12h6M9 16h4',
  group: 'M3 3h7v7H3zM14 14h7v7h-7zM10 7h4v7',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01',
  alignStart: 'M4 3v18M8 7h10v4H8zM8 14h6v4H8z',
  alignCenter: 'M12 3v18M6 7h12v4H6zM8 14h8v4H8z',
  alignEnd: 'M20 3v18M6 7h10v4H6zM10 14h6v4h-6z',
  distribute: 'M4 4v16M20 4v16M9 8h2v8H9zM13 8h2v8h-2z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
