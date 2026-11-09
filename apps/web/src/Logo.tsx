// The Slab: a graded card's case, its label strip, and an M in the window. One colour (currentColor), with real cut-outs, so
// it sits on any background. The same geometry as public/brand/*.svg.
import { useId } from "react";

export function MintentMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect x="12" y="3" width="40" height="58" rx="8" fill="#fff" />
        <rect x="12" y="15" width="40" height="4.5" fill="#000" />
        <path d="M21 53V28.5l11 12 11-12V53" fill="none" stroke="#000" strokeWidth="6.5" strokeMiterlimit="10" />
      </mask>
      <rect width="64" height="64" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

export function Logo({ label }: { label?: string }) {
  return (
    <a className="logo" href="#/" aria-label={label}>
      <MintentMark className="logo__mark" size={38} />
      <span className="logo__word">Mintent<small>on NEAR</small></span>
    </a>
  );
}
