/** Pure helpers for parsing/sanitizing track metadata. Shared between the
 * library list (bulk parse, needs-fix detection) and the metadata edit modal,
 * and exported so they can be unit-tested without rendering a component. */

/** Strip a yt-dlp-style YouTube ID suffix (" [11 chars]"), optionally followed
 * by a file extension. YT IDs are exactly 11 chars from [A-Za-z0-9_-]. */
export const YT_ID_SUFFIX = /\s*\[[A-Za-z0-9_-]{11}\](?=\.[^.]+$|$)/;

export function stripYoutubeId(s: string): string {
  return s.replace(YT_ID_SUFFIX, "");
}

/** Split "Artist - Title" into parts. Returns null if no clean " - " split exists. */
export function parseArtistTitle(source: string): { artist: string; title: string } | null {
  // Strip extension and any trailing YT ID before splitting.
  const noExt = source.replace(/\.[^./\\]+$/, "");
  const stem = stripYoutubeId(noExt).trim();
  const idx = stem.indexOf(" - ");
  if (idx <= 0 || idx >= stem.length - 3) return null;
  const artist = stem.slice(0, idx).trim();
  const title = stem.slice(idx + 3).trim();
  if (!artist || !title) return null;
  return { artist, title };
}

/** Replace filesystem-reserved characters so a string is safe to use in a filename. */
export function sanitizeForFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "_");
}
