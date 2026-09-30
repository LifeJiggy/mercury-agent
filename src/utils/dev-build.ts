/**
 * Development-build marker.
 *
 * Dev-channel builds (scripts/publish-dev.sh → the rolling `mercury-dev-latest`
 * pre-release) are stamped at compile time via MERCURY_CHANNEL_VERSION with a
 * version like `1.2.7-dev.20260929.790d20a`. Every launch surface reads these
 * helpers so a preview binary is visibly a preview AT ALL TIMES — the full
 * version string alone only shows in `--version`, and a long dev stamp is
 * easy to read straight past.
 *
 * Stable builds never contain `-dev.` — the marker must be an unmistakable
 * signal a user did not install the normal distribution.
 */

/** Versions carrying the dev stamp (e.g. `1.2.7-dev.20260929.790d20a`). */
export const DEV_BUILD_PATTERN = /-dev\./;

export function isDevBuild(version: string): boolean {
  return DEV_BUILD_PATTERN.test(version);
}

/**
 * The dev build tag baked into the version — `<date>` plus short commit sha
 * as stamped by publish-dev.sh (`1.2.7-dev.20260929.790d20a` → `20260929.790d20a`).
 * Hand-written dev stamps without the canonical shape fall back gracefully.
 */
export function devBuildTag(version: string): string {
  const match = version.match(/-dev\.([0-9]{8})\.([a-f0-9]+)/);
  return match ? `${match[1]}.${match[2]}` : version.replace(/^.*-dev\./, '');
}

/** Human label used across launch surfaces (stable → ''). */
export function devBuildLabel(version: string): string {
  if (!isDevBuild(version)) return '';
  return `dev build ${devBuildTag(version)}`;
}