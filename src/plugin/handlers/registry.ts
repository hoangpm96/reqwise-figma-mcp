/// <reference types="@figma/plugin-typings" />
import { Operation, OPERATIONS } from "../../shared/protocol.js";
import { HandlerContext } from "../context.js";

import { create } from "./create.js";
import {
  modify,
  deleteNode,
  move,
  resize,
  group,
  ungroup,
  flatten,
  setSelection,
  zoomToFit,
} from "./write.js";
import { clone } from "./clone.js";
import {
  setupTokens,
  applyVariable,
  createVariable,
  updateVariable,
  renameVariable,
  deleteVariable,
  exportTokens,
  importTokens,
} from "./tokens.js";
import { setText } from "./text.js";
import { loadIcon, loadImage, createPage, setCurrentPage, createOverlay } from "./assets.js";
import {
  getDocumentInfo,
  getSelection,
  getDesignContext,
  getNode,
  getNodes,
  searchNodes,
  scanTextNodes,
  scanNodesByTypes,
  getStyles,
  getVariables,
  getComponents,
  getFonts,
  readSelection,
} from "./read.js";
import {
  getComponent,
  getLibraryComponent,
  getDesignSystemKit,
  generateDesignMd,
  designFingerprint,
} from "./design-system.js";
import { screenshot, exportNode } from "./export.js";
import { layoutAudit } from "./audit.js";
import { getDiagramSpec } from "./diagram-spec.js";
import { getPageModel } from "./page-model.js";
import {
  setSelectionColors,
  setGradient,
  setEffects,
  setReactions,
} from "./paint-edit.js";
import { setupTextStyles, setTextStyle, setupEffectStyles } from "./styles.js";
import { createUserflow } from "./userflow.js";
import { createActivity } from "./activity.js";
import { createErd } from "./erd.js";
import { createSequence } from "./sequence.js";
import { createState } from "./state.js";
import { createSitemap } from "./sitemap.js";
import { reflowDiagram } from "./diagram.js";
import { pauseLive, resumeLive } from "../diagram-live.js";
import { endDrawing } from "../diagram-apply.js";
import { deletePage, deleteStyle, deleteUnusedStyles } from "./cleanup.js";

export type Handler = (ctx: HandlerContext) => Promise<unknown>;

/**
 * Hold the live re-router for the length of one draw.
 *
 * Wrapped HERE and not at the dispatcher because there are three places a
 * handler gets called — the op path, the `batch` loop and the direct message
 * path — and a guard that has to be remembered in three places is a guard that
 * will be missed in one. Wrapping the registry entry covers every caller and
 * every future one.
 *
 * `finally`, so a handler that throws still releases it. Counted inside
 * diagram-live, so a `batch` of several draws nests correctly.
 */
function whileDrawing(handler: Handler): Handler {
  return async (ctx: HandlerContext): Promise<unknown> => {
    pauseLive();
    try {
      return await handler(ctx);
    } finally {
      // Before resuming, so the queued pass sees a frame that is finished.
      endDrawing(ctx);
      resumeLive();
    }
  };
}

/**
 * The registry is keyed by every Operation in OPERATIONS. A completeness check
 * below guarantees the plugin cannot silently drop an op the protocol declares.
 * `batch` is registered by main.ts (it needs the dispatcher itself), so it maps
 * to a placeholder here and is overridden at wire-up.
 */
export const HANDLERS: Record<Operation, Handler> = {
  // reads
  get_document_info: getDocumentInfo,
  get_selection: getSelection,
  get_design_context: getDesignContext,
  get_node: getNode,
  get_nodes: getNodes,
  search_nodes: searchNodes,
  scan_text_nodes: scanTextNodes,
  scan_nodes_by_types: scanNodesByTypes,
  get_styles: getStyles,
  get_variables: getVariables,
  get_components: getComponents,
  get_component: getComponent,
  get_library_component: getLibraryComponent,
  get_design_system_kit: getDesignSystemKit,
  generate_design_md: generateDesignMd,
  design_fingerprint: designFingerprint,
  screenshot: screenshot,
  export_node: exportNode,
  get_fonts: getFonts,
  export_tokens: exportTokens,
  layout_audit: layoutAudit,
  get_diagram_spec: getDiagramSpec,
  get_page_model: getPageModel,
  read_selection: readSelection,
  // writes
  create: create,
  modify: modify,
  delete: deleteNode,
  clone: clone,
  move: move,
  resize: resize,
  group: group,
  ungroup: ungroup,
  flatten: flatten,
  batch: async () => {
    throw new Error("batch handler must be provided by the dispatcher");
  },
  setup_tokens: setupTokens,
  setup_text_styles: setupTextStyles,
  set_text_style: setTextStyle,
  setup_effect_styles: setupEffectStyles,
  apply_variable: applyVariable,
  create_variable: createVariable,
  update_variable: updateVariable,
  rename_variable: renameVariable,
  delete_variable: deleteVariable,
  delete_page: deletePage,
  delete_style: deleteStyle,
  delete_unused_styles: deleteUnusedStyles,
  import_tokens: importTokens,
  set_text: setText,
  load_icon: loadIcon,
  load_image: loadImage,
  create_page: createPage,
  set_current_page: setCurrentPage,
  create_overlay: createOverlay,
  set_selection: setSelection,
  zoom_to_fit: zoomToFit,
  // composite edit-in-place ops
  set_selection_colors: setSelectionColors,
  set_gradient: setGradient,
  set_effects: setEffects,
  set_reactions: setReactions,
  create_userflow: whileDrawing(createUserflow),
  create_activity: whileDrawing(createActivity),
  create_erd: whileDrawing(createErd),
  create_sequence: whileDrawing(createSequence),
  create_state: whileDrawing(createState),
  create_sitemap: whileDrawing(createSitemap),
  reflow_diagram: whileDrawing(reflowDiagram),
};

/** Compile-time-ish safety net: every declared op has a handler. */
export function assertRegistryComplete(): string[] {
  const missing: string[] = [];
  for (const op of OPERATIONS) {
    if (typeof HANDLERS[op] !== "function") missing.push(op);
  }
  return missing;
}
