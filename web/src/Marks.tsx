/* ShadeLoop graphic system: hand-drawn-feeling marks built from inline SVG. Decorative marks are aria-hidden. */
import type { ReactNode } from 'react';

/** Topographic contour lines, used as a quiet texture behind the hero and section heads. */
export function Contours({ className = '' }: { className?: string }) {
  return (
    <svg className={`mark contours ${className}`} viewBox="0 0 600 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d="M-20 260 C 80 200 160 290 260 230 S 440 150 620 210" />
        <path d="M-20 228 C 90 170 170 250 270 196 S 450 120 620 176" />
        <path d="M-20 196 C 100 140 180 214 280 164 S 455 92 620 142" />
        <path d="M-20 164 C 110 112 190 180 290 134 S 460 66 620 110" />
        <path d="M 330 80 C 380 40 470 46 492 82 C 512 116 452 140 400 130 C 352 122 300 112 330 80 Z" />
        <path d="M 360 86 C 392 62 448 66 460 88 C 470 108 436 120 404 114 C 374 108 342 102 360 86 Z" />
        <path d="M 392 90 C 408 80 430 82 434 92 C 437 100 420 104 406 102 C 394 100 384 96 392 90 Z" />
        <path d="M-20 300 C 70 250 150 320 250 268 S 430 196 620 250" />
      </g>
    </svg>
  );
}

/** A dashed walking trail with a start ring and an end flag. */
export function Trail({ className = '' }: { className?: string }) {
  return (
    <svg className={`mark trail ${className}`} viewBox="0 0 320 120" aria-hidden="true" focusable="false">
      <path d="M14 96 C 60 20 110 118 160 64 S 250 10 296 34" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="2 9" strokeLinecap="round" />
      <circle cx="14" cy="96" r="7" fill="var(--paper)" stroke="currentColor" strokeWidth="3" />
      <path d="M296 34 V 6 L 316 13 L 296 20" fill="var(--coral)" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

/** A small botanical sprig, drawn with a single stroke weight. */
export function Sprig({ className = '' }: { className?: string }) {
  return (
    <svg className={`mark sprig ${className}`} viewBox="0 0 60 90" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M30 88 C 30 60 28 34 34 6" />
        <path d="M31 66 C 18 64 8 54 6 42 C 18 42 28 50 31 66 Z" fill="var(--lime)" />
        <path d="M31 48 C 44 46 54 36 54 24 C 42 26 33 34 31 48 Z" />
        <path d="M32 30 C 22 28 16 20 16 12 C 26 14 31 20 32 30 Z" />
      </g>
    </svg>
  );
}

/** Brand glyph: a sun half-covered by a leaf loop. */
export function Glyph() {
  return (
    <svg className="glyph" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="17" fill="var(--lime)" stroke="var(--ink)" strokeWidth="2.5" />
      <path d="M7 27 C 14 10 30 8 34 14 C 30 26 18 32 7 27 Z" fill="var(--forest)" stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M10 26 C 18 22 25 18 31 15" fill="none" stroke="var(--lime)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** A numbered field-note label, like a printed index tab: "No. 03 — Steps". */
export function FieldLabel({ n, children, as: Tag = 'h2', id }: { n: number; children: ReactNode; as?: 'h1' | 'h2' | 'h3'; id?: string }) {
  return (
    <Tag className="field-label" id={id}>
      <span className="field-label-no" aria-hidden="true">
        No.{String(n).padStart(2, '0')}
      </span>
      <span>{children}</span>
    </Tag>
  );
}

/** A rotated ink stamp for statuses. Text is real and readable. */
export function Stamp({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`stamp ${tone}`}>{children}</span>;
}

/** Status line used for loading, empty and offline states, with a small drawn mark. */
export function StateNote({ kind, children }: { kind: 'loading' | 'empty' | 'offline'; children: ReactNode }) {
  return (
    <div className={`state-note ${kind}`} role="status">
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        {kind === 'loading' ? (
          <g className="compass" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="24" cy="24" r="19" />
            <path d="M24 9 L29 24 L24 39 L19 24 Z" fill="var(--coral)" strokeLinejoin="round" />
          </g>
        ) : kind === 'offline' ? (
          <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 18 C 16 8 32 8 42 18" />
            <path d="M12 25 C 19 18 29 18 36 25" />
            <circle cx="24" cy="33" r="3" fill="currentColor" />
            <path d="M8 42 L40 6" stroke="var(--coral)" />
          </g>
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <rect x="9" y="6" width="30" height="36" rx="2" />
            <path d="M15 16 H33 M15 23 H33 M15 30 H25" strokeDasharray="2 5" />
          </g>
        )}
      </svg>
      <div>{children}</div>
    </div>
  );
}
