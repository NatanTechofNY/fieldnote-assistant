/**
 * Art for the How it works page. Nothing here comes from the icon set: each
 * step gets a drawn diagram of what actually happens in it, and the small marks
 * are geometry rather than glyphs. They animate on mount — and the ones that
 * describe continuous work keep moving — so the panel has something alive in it.
 * `prefers-reduced-motion` turns all of it off in one rule in the stylesheet.
 */

/** Two doorways, one thread. */
function CaptureArt() {
  return <svg viewBox="0 0 200 210" className="story-art" aria-hidden="true">
    <g className="art-rise art-d1">
      <rect className="art-box" x="4" y="10" width="82" height="40" rx="12"/>
      <path className="art-rule" d="M20 27h44M20 37h26"/>
    </g>
    <g className="art-rise art-d2">
      <rect className="art-box" x="114" y="10" width="82" height="40" rx="12"/>
      <path className="art-rule" d="M130 27h44M130 37h26"/>
    </g>
    <path className="art-flow art-d2" d="M45 50v24c0 12 10 20 22 20h28"/>
    <path className="art-flow art-d3" d="M155 50v24c0 12-10 20-22 20h-28"/>
    <circle className="art-pulse" cx="100" cy="94" r="5"/>
    <path className="art-flow art-d4" d="M100 99v35"/>
    <g className="art-rise art-d5">
      <rect className="art-box art-solid" x="30" y="134" width="140" height="64" rx="16"/>
      <path className="art-rule" d="M50 157h100M50 170h68M50 183h84"/>
    </g>
  </svg>;
}

/** One reasoning node, three things it is allowed to do. */
function DecideArt() {
  return <svg viewBox="0 0 200 210" className="story-art" aria-hidden="true">
    <g className="art-rise art-d1">
      <rect className="art-box art-solid" x="56" y="8" width="88" height="46" rx="14"/>
      <path className="art-rule" d="M74 26h52M74 38h30"/>
    </g>
    <circle className="art-ring" cx="100" cy="31" r="30"/>
    <path className="art-flow art-d2" d="M100 54v22c0 12-10 18-22 18H40c-12 0-18 8-18 18v12"/>
    <path className="art-flow art-d3" d="M100 54v70"/>
    <path className="art-flow art-d4" d="M100 54v22c0 12 10 18 22 18h38c12 0 18 8 18 18v12"/>
    <g className="art-rise art-d3">
      <rect className="art-box" x="0" y="124" width="44" height="38" rx="12"/>
      <circle className="art-dot art-d3" cx="22" cy="143" r="3.5"/>
    </g>
    <g className="art-rise art-d4">
      <rect className="art-box" x="78" y="124" width="44" height="38" rx="12"/>
      <path className="art-rule" d="M90 138h20M90 148h12"/>
    </g>
    <g className="art-rise art-d5">
      <rect className="art-box" x="156" y="124" width="44" height="38" rx="12"/>
      <path className="art-tick" d="M168 143l6 7 12-14"/>
    </g>
    <path className="art-rule art-d5" d="M22 168v14h156v-14"/>
  </svg>;
}

/** Records land in SQLite; the outbox remembers what to sync. */
function CommitArt() {
  return <svg viewBox="0 0 200 210" className="story-art" aria-hidden="true">
    <g className="art-drop art-d1"><rect className="art-box art-solid" x="56" y="2" width="88" height="16" rx="7"/></g>
    <g className="art-drop art-d3"><rect className="art-box art-solid" x="56" y="26" width="88" height="16" rx="7"/></g>
    <g className="art-drop art-d5"><rect className="art-box" x="56" y="50" width="88" height="16" rx="7"/></g>
    <g className="art-rise art-d2">
      <ellipse className="art-box" cx="100" cy="102" rx="54" ry="17"/>
      <path className="art-box" d="M46 102v44c0 9 24 17 54 17s54-8 54-17v-44"/>
      <path className="art-rule" d="M46 126c0 9 24 17 54 17s54-8 54-17"/>
    </g>
    <g className="art-rise art-d4">
      <rect className="art-box" x="2" y="178" width="60" height="28" rx="10"/>
      <path className="art-tick" d="M18 192l6 7 12-14"/>
    </g>
    <path className="art-flow art-d5" d="M62 192h76"/>
  </svg>;
}

/** Keywords and vectors blend into one ranked answer. */
function RecallArt() {
  return <svg viewBox="0 0 200 210" className="story-art" aria-hidden="true">
    <g className="art-rise art-d1">
      <rect className="art-bar" x="0" y="12" width="70" height="10" rx="5"/>
      <rect className="art-bar" x="0" y="30" width="48" height="10" rx="5"/>
      <rect className="art-bar" x="0" y="48" width="60" height="10" rx="5"/>
    </g>
    <g className="art-rise art-d2">
      <path className="art-rule" d="M172 20l-24 22 30 16-14 20"/>
      <circle className="art-dot art-d1" cx="172" cy="20" r="4"/>
      <circle className="art-dot art-d3" cx="148" cy="42" r="3"/>
      <circle className="art-dot art-d2" cx="178" cy="58" r="5"/>
      <circle className="art-dot art-d4" cx="164" cy="78" r="3.5"/>
    </g>
    <path className="art-flow art-d3" d="M35 62v22c0 12 10 18 22 18h34"/>
    <path className="art-flow art-d4" d="M165 86v0c0 12-10 16-22 16h-34"/>
    <circle className="art-pulse" cx="100" cy="102" r="5"/>
    <g className="art-rise art-d5">
      <rect className="art-box art-solid" x="14" y="130" width="172" height="24" rx="9"/>
      <rect className="art-box" x="14" y="162" width="172" height="24" rx="9"/>
      <rect className="art-box" x="14" y="194" width="172" height="16" rx="8"/>
    </g>
  </svg>;
}

const stepArt = [CaptureArt, DecideArt, CommitArt, RecallArt];

export function StoryArt({ step }: { step: number }) {
  const Art = stepArt[step] ?? CaptureArt;
  return <Art />;
}

/** Small geometric marks for the four loops. */
export function LoopMark({ name }: { name: "plan" | "memory" | "thread" | "window" }) {
  if (name === "plan") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M2.5 5.5l2 2 3.5-4"/><path d="M11 6h7"/>
    <path d="M2.5 12.5l2 2 3.5-4"/><path d="M11 13h4.5"/>
  </svg>;
  if (name === "memory") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M6 5.5l8 3-8 6 8-2"/>
    <circle cx="6" cy="5.5" r="1.8"/><circle cx="14.5" cy="8.5" r="1.8"/>
    <circle cx="5.5" cy="14.5" r="1.8"/><circle cx="14.5" cy="12.5" r="1.8"/>
  </svg>;
  if (name === "thread") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M2.5 4.5h11v6h-7l-4 3z"/><path d="M17.5 8v6.5h-6"/>
  </svg>;
  return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M6 3.5H3v13h3M14 3.5h3v13h-3"/><path d="M10 7.5v5"/>
  </svg>;
}

/** One drawn mark per connection, so the doors are not four library glyphs. */
export function DoorMark({ name }: { name: "sms" | "imessage" | "notes" | "board" }) {
  if (name === "sms") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <circle cx="10" cy="14.5" r="1.6" className="setup-mark-fill"/>
    <path d="M6.5 11.5a5 5 0 017 0"/><path d="M3.5 8a9.5 9.5 0 0113 0"/>
  </svg>;
  // A bubble with a tail, and the three dots that answer before the reply does.
  if (name === "imessage") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M10 3c4.1 0 7.5 2.7 7.5 6.1 0 3.3-3.4 6-7.5 6-.8 0-1.6-.1-2.4-.3L3.4 17l1-3.3A5.8 5.8 0 012.5 9.1C2.5 5.7 5.9 3 10 3z"/>
    <circle cx="6.9" cy="9.1" r=".9" className="setup-mark-fill"/>
    <circle cx="10" cy="9.1" r=".9" className="setup-mark-fill"/>
    <circle cx="13.1" cy="9.1" r=".9" className="setup-mark-fill"/>
  </svg>;
  if (name === "notes") return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M4 2.5h8l4 4v11H4z"/><path d="M12 2.5v4h4"/><path d="M7 11h6M7 14h4"/>
  </svg>;
  return <svg viewBox="0 0 20 20" className="setup-mark" aria-hidden="true">
    <path d="M2.5 3.5h5v9h-5zM12.5 3.5h5v13h-5"/><path d="M2.5 7h5M12.5 7h5M12.5 12.5h5"/>
  </svg>;
}
