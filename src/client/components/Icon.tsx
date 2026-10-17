import type { ReactNode } from 'react';

type IconName = 'arrow' | 'pin' | 'music' | 'walk' | 'clock' | 'calendar' | 'spark' | 'swap' | 'external' | 'chevron' | 'close' | 'food' | 'culture' | 'shop' | 'outdoors' | 'tune' | 'history' | 'undo' | 'phone' | 'edit' | 'more' | 'chat' | 'share' | 'copy';
const paths: Record<IconName, ReactNode> = {
  share: <><path d="M12 15V3m-4 4 4-4 4 4M7 10H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="3" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  chat: <path d="M8 4h8a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5h-5l-6 3v-4a5 5 0 0 1-2-4V9a5 5 0 0 1 5-5Z" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  tune: <><path d="M4 7h6m4 0h6M4 17h10m4 0h2" /><circle cx="12" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></>,
  history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" /></>,
  undo: <><path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" /></>,
  edit: <><path d="M13 5 19 11M4 20l4-1 12-12a2 2 0 0 0-6-3L3 16l1 4ZM12 20h9" /></>,
  phone: <path d="m7 3-4 2c0 9 7 16 16 16l2-4-5-3-2 2c-3-1-5-3-6-6l2-2-3-5Z" />,
  arrow: <><path d="M4 12h15M13 6l6 6-6 6" /></>,
  pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  music: <><path d="M9 17V5l11-2v12M9 9l11-2" /><ellipse cx="6" cy="17" rx="3" ry="2.5" /><ellipse cx="17" cy="15" rx="3" ry="2.5" /></>,
  walk: <><circle cx="14" cy="4" r="2" /><path d="m7 21 4-7-2-4 4-3 3 4 4 1M11 14l5 3 1 4M9 10l-4 3" /></>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4M16 3v4M4 11h16" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  spark: <><path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6L12 2Z" /></>,
  swap: <><path d="M4 7h15l-4-4M20 17H5l4 4M19 7v4M5 17v-4" /></>,
  external: <><path d="M14 4h6v6M20 4 10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  food: <><path d="M4 4v5a3 3 0 0 0 6 0V4M7 4v17M20 21V4c-4 0-5 5-5 9h5" /></>,
  culture: <><path d="m3 8 9-5 9 5H3ZM5 11v7M10 11v7M14 11v7M19 11v7M3 21h18" /></>,
  shop: <><path d="M5 8h14l2 13H3L5 8ZM8 8V6a4 4 0 0 1 8 0v2" /></>,
  outdoors: <><path d="m12 3 6 8h-3l5 7H4l5-7H6l6-8ZM12 18v4" /></>,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string; }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}
