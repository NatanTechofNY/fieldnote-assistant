import { listStoreProducts, STORE_NAME } from "./db.ts";
import type { Db, StoreProductRow } from "./types.ts";

export interface ProductSearchOptions {
  query: string;
  category?: string | null;
  maxPriceCents?: number | null;
  limit?: number;
}

export interface ProductJson {
  id: string;
  store: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  symptoms: string[];
  size: string | null;
  price: string;
  price_cents: number;
  image_url: string;
  product_url: string;
}

export const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function productJson(row: StoreProductRow): ProductJson {
  return {
    id: row.id,
    store: row.store,
    name: row.name,
    brand: row.brand,
    description: row.description,
    category: row.category,
    symptoms: JSON.parse(row.symptoms_json) as string[],
    size: row.size,
    price: formatPrice(row.price_cents),
    price_cents: row.price_cents,
    image_url: row.image_url,
    product_url: row.product_url,
  };
}

/** The text that rides under a product image in Messages. */
export function productCaption(row: StoreProductRow): string {
  const size = row.size ? ` (${row.size})` : "";
  return `${row.name}${size} — ${formatPrice(row.price_cents)}\n${row.product_url}`;
}

/**
 * The local-mode stand-in for the Algolia products index. "Headache" has to
 * find Advil even though the word is only in its symptom list, so every term is
 * matched against name, brand, description, category, and symptoms, and a row
 * scores by how many terms it matches before popularity breaks the tie.
 */
export function searchStoreProductsLocally(db: Db, options: ProductSearchOptions): StoreProductRow[] {
  const terms = options.query.toLowerCase().split(/[^a-z0-9'&-]+/).filter(term => term.length > 1);
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
  const rows = listStoreProducts(db).filter(row =>
    (!options.category || row.category === options.category)
    && (options.maxPriceCents == null || row.price_cents <= options.maxPriceCents),
  );
  if (terms.length === 0) return rows.slice(0, limit);
  const haystack = (row: StoreProductRow) =>
    `${row.name} ${row.brand} ${row.description} ${row.category} ${(JSON.parse(row.symptoms_json) as string[]).join(" ")}`
      .toLowerCase();
  const scored = rows
    .map(row => {
      const text = haystack(row);
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      return { row, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.row.popularity - a.row.popularity);
  return scored.slice(0, limit).map(entry => entry.row);
}

export { STORE_NAME };
