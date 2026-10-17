/** Provider tag IDs establish evidence; display labels and short values never do. */
export interface ProviderTag {id: string; type?: string}
const tagUrn = /^urn:tag:[a-z0-9_-]+(?::[a-z0-9_-]+)*$/i;
const identifyingPlace = /^urn:tag:(?:category|genre):place(?::|$)/;
const identifyingRoot = /^urn:tag:(?:category|genre):place$/;
function urn(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length <= 200 && tagUrn.test(text) ? text : undefined;
}
export function isIdentifyingPlaceTag(id: string): boolean {return identifyingPlace.test(id);}
export function providerTag(value: unknown): ProviderTag | undefined {
  if (typeof value === 'string') {const id = urn(value); return id ? {id} : undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = [item.id, item.tag_id, item.value].map(urn).find(Boolean);
  if (!id) return undefined;
  const type = item.type === undefined || item.type === null ? undefined : urn(item.type);
  if (item.type !== undefined && item.type !== null && !type) return undefined;
  // Category/genre are interchangeable identifying roots in Qloo endpoint shapes.
  // Ancillary families cannot masquerade as identifying or dining evidence.
  if (type && !(identifyingRoot.test(type) && identifyingPlace.test(id)) && id !== type && !id.startsWith(`${type}:`)) return undefined;
  return {id, ...(type ? {type} : {})};
}
export function providerTags(entity: Record<string, unknown>): ProviderTag[] {
  return (Array.isArray(entity.tags) ? entity.tags : []).flatMap(value => {const tag = providerTag(value); return tag ? [tag] : [];});
}
