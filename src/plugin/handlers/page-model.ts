/// <reference types="@figma/plugin-typings" />
/**
 * `get_page_model`: every model this page — or this whole file — holds, read
 * back off the frames.
 *
 * Each diagram frame remembers the model it was drawn from, so the file is
 * already a machine-readable record of everything anybody has drawn in it —
 * no glossary to maintain, and no dependence on one chat remembering what
 * another chat did last week. That is what lets the tools ask whether the
 * diagrams agree with each other, and it is the thing mermaid and plantuml
 * cannot do at all, because there every diagram is an island.
 *
 * `scope:"file"` is opt-in and deliberately not the default. Under
 * `documentAccess: "dynamic-page"` the other pages are not in memory, so
 * reading them means `loadAllPagesAsync()` — one await, but one that loads
 * every page of the document and is slow on a large file. The check that runs
 * on every draw stays page-local for exactly that reason; this is the call an
 * agent makes ONCE, at the start of a session, to find out what already exists.
 */
import { HandlerContext, getNodeByIdSafe } from "../context.js";
import { canvasChildren, pageArtboards, readDiagramSource } from "../diagram-apply.js";
import { isDiagramFrameName } from "../diagram-mark.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

export async function getPageModel(ctx: HandlerContext): Promise<unknown> {
  const scope = ctx.params.scope === "file" ? "file" : "page";
  const pageId = String(ctx.params.pageId ?? "");

  if (scope === "file") {
    await figma.loadAllPagesAsync?.();
    const pages = figma.root.children as readonly PageNode[];
    const diagrams: Array<Record<string, unknown>> = [];
    const artboards: Array<{ nodeId: string; name: string }> = [];
    for (const page of pages) {
      // Belt and braces: on a runtime with no loadAllPagesAsync (hence the
      // `?.` above) this is the only load the walk gets.
      await page.loadAsync?.();
      collect(page, diagrams, true);
      for (const a of pageArtboards(page)) artboards.push(a);
    }
    return { scope, pages: pages.length, diagrams, artboards };
  }

  let page: BaseNode | null = figma.currentPage;
  if (pageId) {
    page = await getNodeByIdSafe(pageId);
    if (!page || page.type !== "PAGE") {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        `No page with id "${pageId}".`,
        'Omit pageId for the current page, or pass scope:"file" for all of them. figma_read get_document_info lists them.',
      );
    }
  }
  // A page that is not the current one is not in memory under
  // `documentAccess: "dynamic-page"` — reading its `children` throws until
  // loadAsync runs. On the current page this early-returns.
  await (page as PageNode).loadAsync?.();
  const diagrams: Array<Record<string, unknown>> = [];
  collect(page as PageNode, diagrams, false);
  return {
    scope,
    pageId: page.id,
    name: (page as PageNode).name,
    diagrams,
    artboards: pageArtboards(page as PageNode),
  };
}

function collect(
  page: PageNode,
  into: Array<Record<string, unknown>>,
  withPage: boolean,
): void {
  // canvasChildren, like `artboards` below it: a diagram dragged into a
  // SECTION was left out entirely — not even listed as unreadable — so the
  // cross-check ran on a partial page and reported nothing.
  for (const child of canvasChildren(page)) {
    const mark = readDiagramSource(child);

    // A frame drawn by an older build carries no `kind`, so nothing here can
    // read it. Say so instead of omitting it: silently leaving it out means a
    // page that LOOKS compared but has a diagram in it that no check ever saw,
    // which is worse than admitting the gap. One redraw fixes it.
    if (!mark.kind) {
      if (child.type === "FRAME" && isDiagramFrameName(child.name)) {
        into.push({
          nodeId: child.id,
          name: child.name,
          unreadable: true,
          ...(withPage ? { page: page.name, pageId: page.id } : {}),
        });
      }
      continue;
    }
    into.push({
      nodeId: child.id,
      kind: mark.kind,
      ...(mark.title ? { title: mark.title } : {}),
      // Only when it can matter: on one page it is noise on every entry, and
      // across pages it is what tells two findings apart.
      ...(withPage ? { page: page.name, pageId: page.id } : {}),
      // A frame drawn before the model was stored still counts as a diagram —
      // the caller needs to know it is there and that it cannot be compared.
      ...(mark.source === undefined ? { stale: true } : { spec: mark.source }),
    });
  }
}
