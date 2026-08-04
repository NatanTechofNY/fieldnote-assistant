/**
 * Titles only. A page's actions belong on its toolbar row, because the top-right
 * corner of every page now holds the floating search and agent launcher.
 */
export function PageHead({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-head">
    <div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{description}</p></div>
  </header>;
}
