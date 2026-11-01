/**
 * Retina-aware ResizeObserver helper.
 * Observes a `.viewport` container and sizes its child `<canvas>` element(s)
 * to `Math.floor(rect.width * dpr)` by `Math.floor(rect.height * dpr)` without
 * ever mutating layout dimensions.
 */

export interface ViewportSize {
  /** Logical CSS pixels. */
  width: number;
  height: number;
  /** Current devicePixelRatio (clamped to [1, 3]). */
  dpr: number;
  /** Physical backing store pixels. */
  pxWidth: number;
  pxHeight: number;
}

export function observeViewport(
  container: HTMLElement,
  onResize: (size: ViewportSize) => void,
): () => void {
  const canvases = Array.from(container.querySelectorAll('canvas'));
  let lastW = 0;
  let lastH = 0;
  let lastDpr = 0;

  const update = () => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (width === lastW && height === lastH && dpr === lastDpr) return;
    lastW = width;
    lastH = height;
    lastDpr = dpr;
    const pxWidth = Math.max(1, Math.floor(width * dpr));
    const pxHeight = Math.max(1, Math.floor(height * dpr));
    for (const c of canvases) {
      if (c.width !== pxWidth) c.width = pxWidth;
      if (c.height !== pxHeight) c.height = pxHeight;
    }
    onResize({ width, height, dpr, pxWidth, pxHeight });
  };

  const ro = new ResizeObserver(() => update());
  ro.observe(container);
  window.addEventListener('resize', update);
  // Perform initial measurement synchronously if layout is ready.
  update();

  return () => {
    ro.disconnect();
    window.removeEventListener('resize', update);
  };
}

