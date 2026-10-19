// Plain decimal only: rejects hex ("0x10"), exponents ("1e1") and "Infinity",
// which Number() would accept but OSRM would not read the same way.
const DECIMAL = /^-?\d+(\.\d+)?$/;

// Parses a "lng,lat" string. Returns the normalized string, or null if invalid.
export function parseCoordinate(value) {
  if (typeof value !== 'string') return null;

  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || !parts.every((part) => DECIMAL.test(part))) return null;

  const [lng, lat] = parts.map(Number);
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;

  return `${parts[0]},${parts[1]}`;
}
