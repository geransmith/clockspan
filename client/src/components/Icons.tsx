import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const ChevronLeft = () => (
  <svg {...base}>
    <path d="m15 18-6-6 6-6" />
  </svg>
);
export const ChevronRight = () => (
  <svg {...base}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);
export const Gear = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const List = () => (
  <svg {...base}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
/** The board's header button: four columns side by side. */
export const Columns = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7.5 4v16M12 4v16M16.5 4v16" />
  </svg>
);
export const Layout = () => (
  <svg {...base}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 12h18M12 3v18" />
  </svg>
);
export const Grip = () => (
  <svg {...base}>
    <circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);
export const EyeOff = () => (
  <svg {...base}>
    <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a10 10 0 0 0 5.4-1.6M1 1l22 22" />
    <path d="M14.1 14.1a3 3 0 0 1-4.2-4.2" />
  </svg>
);
export const X = () => (
  <svg {...base}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
export const Check = () => (
  <svg {...base}>
    <path d="m20 6-11 11-5-5" />
  </svg>
);
export const ArrowUp = () => (
  <svg {...base}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const ArrowDown = () => (
  <svg {...base}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);
export const ArrowLeft = () => (
  <svg {...base}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
export const ArrowRight = () => (
  <svg {...base}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);
export const Trash = () => (
  <svg {...base}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  </svg>
);
export const Plus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Minus = () => (
  <svg {...base}>
    <path d="M5 12h14" />
  </svg>
);
export const Pause = () => (
  <svg {...base}>
    <path d="M8 5v14M16 5v14" />
  </svg>
);
export const Play = () => (
  <svg {...base}>
    <path d="m7 4 13 8-13 8z" />
  </svg>
);
export const Bell = () => (
  <svg {...base}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);
/** A recurring priority's mark: two arrows chasing round. */
export const Repeat = () => (
  <svg {...base}>
    <path d="m17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);
/** A task's note: a page with lines, filled with its lines cut out (in the surface's colour) when the task has one. */
export const Note = ({ filled = false }: { filled?: boolean }) => (
  <svg {...base}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill={filled ? 'currentColor' : 'none'} />
    <path d="M14 3v6h6" />
    <path d="M8 13h8M8 17h5" style={filled ? { stroke: 'var(--surface)' } : undefined} />
  </svg>
);
