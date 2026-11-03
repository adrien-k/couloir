import UserError from "./user-error.js";

/** RFC 1123 DNS label: 1–63 chars, alphanumeric, hyphens not at either end. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isDnsLabel(value) {
  return typeof value === "string" && DNS_LABEL.test(value);
}

/**
 * Normalize a client- or control-API-supplied couloir name to a single DNS label.
 * Empty / missing values are returned as-is so the relay can auto-assign a name.
 */
export function normalizeCouloirLabel(couloirLabel) {
  if (couloirLabel == null || couloirLabel === "") {
    return couloirLabel;
  }
  if (typeof couloirLabel !== "string") {
    throw new UserError("Invalid couloir name. Use a single DNS label (letters, digits, hyphens; 1-63 characters).");
  }

  const label = couloirLabel.toLowerCase();
  if (!isDnsLabel(label)) {
    throw new UserError(
      `Invalid couloir name "${couloirLabel}". Use a single DNS label (letters, digits, hyphens; 1-63 characters).`,
    );
  }
  return label;
}
