

export function LifeAreaPill({ name, slug }: { name?: string | null; slug?: string | null }) {
  if (!name) return null;
  return <span className={`life-area-pill ${slug || ""}`}>{name}</span>;
}
