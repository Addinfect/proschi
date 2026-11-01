/** Fill for a utilisation: calm paper, then yellow, pink, red; grey when down. Shared by the editor's overlay and the Arcade. */
export function heat(u: number | undefined, down = false): string {
  if (down) return 'rgb(var(--c-muted) / 0.35)';
  if (u === undefined || u < 0.4) return 'rgb(var(--c-surface))';
  // 0.4, not more: ink on it keeps 4.5:1 on the dark theme's surface too.
  if (u < 0.7) return 'rgb(var(--c-yellow) / 0.4)';
  if (u < 0.9) return 'rgb(var(--c-yellow))';
  if (u < 1) return 'rgb(var(--c-pink))';
  return 'rgb(var(--c-fail))';
}

/**
 * Which text the fill takes, for canvas.css: `warm` (the tinted yellow) keeps
 * the ink but drops the muted grey, `accent` (a solid yellow, pink or red,
 * the same in both themes) takes the dark text drawn on accents.
 */
export function heatText(u: number | undefined, down = false): 'warm' | 'accent' | undefined {
  if (down || u === undefined || u < 0.4) return undefined;
  return u < 0.7 ? 'warm' : 'accent';
}
