/// <reference types="@figma/plugin-typings" />
/**
 * Scale SVG artwork `createNodeFromSvg` just made so it actually fits.
 *
 * The obvious version — `frame.resize(88, 88)` — does not work, and the way it
 * fails is worth writing down. `createNodeFromSvg` returns a clipping FRAME at
 * the SVG's own size wrapping one group whose constraints are SCALE. Resizing
 * the frame hands the artwork to Figma's constraint pass, which scales it by
 * the WIDTH factor on both axes and leaves it a fraction TALLER than the frame
 * it now lives in — 88.91 inside 88. Correcting that afterwards does not hold
 * either: the constraint pass runs after the handler's own writes and puts the
 * group back at 0,0.
 *
 * `rescale` is a different operation: it scales the node's geometry, children
 * and all, with no layout pass to fight. The frame comes out at the artwork's
 * true aspect — a hair off square, which is why the caller centres it rather
 * than trusting the corner — and the clip is turned off because nothing needs
 * clipping once the artwork fits. Both halves matter to `layout_audit`: it
 * reports an overflow AND a "clipped by" line per vector.
 *
 * Lifted out of the persona handler the moment a second caller (design-system
 * icons, `load_icon`) needed the same fix. Do not write a second copy.
 */
export function fitArtwork(node: SceneNode, width: number): void {
  // A non-positive or non-finite target (size:0) would rescale by zero or
  // worse — rescale needs a positive factor.
  if ("rescale" in node && node.width > 0 && Number.isFinite(width) && width > 0) {
    const factor = width / node.width;
    if (Math.abs(factor - 1) > 0.001) (node as FrameNode).rescale(factor);
  }
  if ("clipsContent" in node) (node as FrameNode).clipsContent = false;
  if (!("children" in node)) return;
  const frame = node as FrameNode;
  const art = frame.children[0];
  if (!art || !art.width || !art.height) return;
  const spare = Math.min(frame.width / art.width, frame.height / art.height);
  if (spare < 0.999 && "rescale" in art) (art as GroupNode).rescale(spare);
  if (art.height > frame.height + 0.01 || art.width > frame.width + 0.01) {
    if ("resize" in art) {
      (art as GroupNode).resize(
        Math.min(art.width, frame.width),
        Math.min(art.height, frame.height),
      );
    }
  }
  art.x = (frame.width - art.width) / 2;
  art.y = (frame.height - art.height) / 2;
  closeNestedOverflow(frame);
}

function closeNestedOverflow(parent: FrameNode | GroupNode): void {
  if (!("children" in parent)) return;
  for (const child of parent.children) {
    if (!("width" in child) || !("height" in child)) continue;
    if (
      (child.height > parent.height + 0.01 || child.width > parent.width + 0.01) &&
      "resize" in child
    ) {
      (child as GroupNode).resize(
        Math.min(child.width, parent.width),
        Math.min(child.height, parent.height),
      );
    }
    if ("children" in child) closeNestedOverflow(child as GroupNode);
  }
}
