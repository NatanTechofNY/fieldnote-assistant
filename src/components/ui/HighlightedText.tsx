import { Fragment } from "react";
import { splitByTerms } from "../../lib/highlight";

/** Plain text with the search terms it matched marked. */
export function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  return <>{splitByTerms(text, terms).map((part, index) => part.match
    ? <mark key={index} className="search-mark">{part.value}</mark>
    : <Fragment key={index}>{part.value}</Fragment>)}</>;
}
