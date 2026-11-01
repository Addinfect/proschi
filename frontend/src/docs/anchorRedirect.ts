/**
 * Old anchors of a docs page that moved to another page (docs/site.json
 * `anchorRedirects`, put on the page by plugins/docsSite.ts): the URL a hash
 * should go to instead, or undefined when it still lives here. Targets are
 * relative to /docs/: `hld/#traffic`, `scenarios/`.
 */
export function anchorRedirect(map: Record<string, string>, hash: string, docsRoot: string): string | undefined {
  let anchor = hash.replace(/^#/, '');
  try {
    anchor = decodeURIComponent(anchor);
  } catch {
    // A malformed escape: match the raw text.
  }
  const target = Object.hasOwn(map, anchor) ? map[anchor] : undefined;
  return target === undefined ? undefined : new URL(target, docsRoot).href;
}
