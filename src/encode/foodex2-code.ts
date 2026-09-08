/**
 * Assemble a FoodEx2 code string from base + added facet descriptors.
 */

import type { FacetDescriptorRef } from "./types.js";

/** Sort by facet header, then descriptor code (EFSA alphanumeric facet order). */
export function sortFacets(facets: FacetDescriptorRef[]): FacetDescriptorRef[] {
  return [...facets].sort((a, b) => {
    const byHeader = a.header.localeCompare(b.header);
    if (byHeader !== 0) return byHeader;
    return a.code.localeCompare(b.code);
  });
}

export function formatFoodEx2Code(baseCode: string, facets: FacetDescriptorRef[]): string {
  const sorted = sortFacets(facets);
  if (sorted.length === 0) return baseCode;
  return `${baseCode}#${sorted.map((f) => `${f.header}.${f.code}`).join("$")}`;
}
