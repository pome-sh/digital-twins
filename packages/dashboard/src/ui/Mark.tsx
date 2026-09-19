// SPDX-License-Identifier: Apache-2.0
//
// The Pome mark, inline — `assets/pome-mark.svg` from the design system. Inline
// rather than an <img>, so it is not a fourth file for a server that serves
// exactly three, and so it keeps its colours without a request.

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className={className}>
      <g fill="none" stroke="#4a6b3a" strokeLinecap="round" strokeWidth="7.5">
        <path d="M24 45.5 C 31.6 35, 42.2 28.2, 53.6 24.8" />
        <path d="M31.2 62.5 C 36.4 55, 42.4 50.4, 49.8 47.4" />
      </g>
      <circle cx="68" cy="40" r="5.4" fill="#d4a017" />
    </svg>
  );
}
