// Plain decimal only: rejects hex ("0x10"), exponents ("1e1") and "Infinity",
// which Number() would accept but OSRM would not read the same way.
const DECIMAL = /^-?\d+(\.\d+)?$/;

// A validated "lng,lat" string, as OSRM expects it in a URL path.
export type Coordinate = string & { readonly __brand: 'Coordinate' };

// Parses a "lng,lat" string. Returns the normalized string, or null if invalid.
// Takes `unknown` because query parameters can be arrays or objects too.
export function parseCoordinate(value: unknown): Coordinate | null {
  if (typeof value !== 'string') return null;

  const parts = value.split(',').map((part) => part.trim());
  const [lngText, latText] = parts;
  if (parts.length !== 2 || lngText === undefined || latText === undefined) return null;
  if (!DECIMAL.test(lngText) || !DECIMAL.test(latText)) return null;

  const lng = Number(lngText);
  const lat = Number(latText);
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;

  return `${lngText},${latText}` as Coordinate;
}
