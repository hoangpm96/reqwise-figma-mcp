/// <reference types="@figma/plugin-typings" />
import { HandlerContext, findNode } from "../context.js";
import { err } from "../errors.js";
import {
  plainValue,
  serializeTree,
  normalizeDetail,
  readComponentPropertyDefinitions,
  Detail,
} from "../serialize.js";
import { rgbToHex } from "../color-util.js";
import { ErrorCode } from "../../shared/protocol.js";
import {
  renderDesignMarkdown,
  type DesignSystemKit,
  type DesignComponent,
  type DesignMarkdownOptions,
  type DesignComponentUsage,
  type DesignExternalComponent,
  type DesignObservedPatterns,
  type DesignScreen,
} from "../../shared/design-system.js";

export async function getComponent(ctx: HandlerContext): Promise<unknown> {
  const node = await resolveComponentNode(ctx.params);
  const depth = numberParam(ctx.params.depth, 3);
  const detail = normalizeDetail(ctx.params.detail ?? "design");
  return {
    component: await serializeComponent(node, {
      detail,
      depth,
      includeAnatomy: ctx.params.includeAnatomy !== false,
      includeInstances: ctx.params.includeInstances === true,
    }),
  };
}

/**
 * get_library_component: import a component (or component set) from a
 * PUBLISHED shared library by key and return the same rich serialization as
 * get_component — props, variants and anatomy double as a reconstruction
 * spec when the library itself is not editable.
 */
export async function getLibraryComponent(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const key = String(p.key ?? "").trim();
  if (!key) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "get_library_component requires a key.",
      "Component keys come from get_component(.key), the library file, or the Figma REST API.",
    );
  }
  const kind =
    p.type === "set" ? "set" : p.type === "component" ? "component" : "auto";
  // importComponentByKeyAsync HANGS (never settles) on an unpublished key —
  // observed live 2026-07-20 — so every import races an internal timeout;
  // otherwise the op eats the full bridge budget and blocks the channel.
  // NOT numberParam — that helper clamps to the depth range [0, 8].
  const timeoutMs =
    typeof p.importTimeoutMs === "number" && p.importTimeoutMs > 0
      ? p.importTimeoutMs
      : 20_000;
  const raced = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`import did not respond within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let node: ComponentNode | ComponentSetNode | null = null;
  let importError: string | undefined;
  if (kind !== "set") {
    try {
      node = await raced(figma.importComponentByKeyAsync(key));
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!node && kind !== "component") {
    try {
      node = await raced(figma.importComponentSetByKeyAsync(key));
    } catch (e) {
      importError = importError ?? (e instanceof Error ? e.message : String(e));
    }
  }
  if (!node) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `Could not import a library component with key "${key}"${importError ? ` (${importError})` : ""}.`,
      "The key must belong to a PUBLISHED library this user/file can access — enable it under Assets → Libraries, or check the key. An import that times out usually means the key is local/unpublished — resolve those via get_component instead.",
    );
  }

  const depth = numberParam(p.depth, 3);
  const detail = normalizeDetail(p.detail ?? "design");
  return {
    imported: true,
    remote: (node as ComponentNode).remote === true,
    component: await serializeComponent(node, {
      detail,
      depth,
      includeAnatomy: p.includeAnatomy !== false,
      includeInstances: false,
    }),
  };
}

export async function getDesignSystemKit(ctx: HandlerContext): Promise<unknown> {
  return collectDesignSystemKit(ctx);
}

export async function generateDesignMd(ctx: HandlerContext): Promise<unknown> {
  const kit = await collectDesignSystemKit(ctx);
  const markdown = renderDesignMarkdown(kit, markdownOptions(ctx.params));
  const base = { markdown, extraction: kit.extraction };
  return ctx.params.includeJson === true ? { ...base, kit } : base;
}

export async function listComponents(params: Record<string, unknown> = {}): Promise<{ count: number; total: number; omittedCount: number; components: DesignComponent[] }> {
  await figma.loadAllPagesAsync?.();
  const detail = normalizeDetail(params.detail);
  const depth = numberParam(params.depth, detail === "design" ? 2 : 0);
  const includeAnatomy = params.includeAnatomy === true;
  const includeInstances = params.includeInstances === true;
  const maxComponents = optionalNumberParam(params.maxComponents);
  const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  const selected = maxComponents === undefined ? nodes : nodes.slice(0, maxComponents);

  const components: DesignComponent[] = [];
  for (let i = 0; i < selected.length; i++) {
    components.push(
      await serializeComponent(selected[i]!, {
        detail,
        depth,
        includeAnatomy,
        includeInstances,
      }),
    );
    if ((i + 1) % 25 === 0) await yieldToPlugin();
  }
  return { count: components.length, total: nodes.length, omittedCount: Math.max(0, nodes.length - components.length), components };
}

async function collectDesignSystemKit(ctx: HandlerContext): Promise<DesignSystemKit> {
  const detail = normalizeDetail(ctx.params.detail ?? "design");
  const depth = numberParam(ctx.params.depth, 2);
  const includeScreens = ctx.params.includeScreens !== false;
  const includeComponentUsage = ctx.params.includeComponentUsage !== false;
  const [styles, variables, components] = await Promise.all([
    getRichStyles(),
    getRichVariables(),
    listComponents({
      detail,
      depth,
      includeAnatomy: ctx.params.includeAnatomy === true,
      includeInstances: ctx.params.includeInstances === true,
      maxComponents: ctx.params.maxComponents,
    }),
  ]);

  const evidence = await collectDocumentEvidence(ctx, {
    includeScreens,
    includeComponentUsage,
    screenDepth: numberParam(ctx.params.screenDepth, 4),
    maxScreens: boundedCountParam(ctx.params.maxScreens, 80, 500),
    maxInstances: boundedCountParam(ctx.params.maxInstances, 2_000, 20_000),
  });
  for (const component of components.components) {
    const usage = evidence.usageByComponentId.get(component.id);
    if (usage) component.usageStats = usage;
  }

  return {
    file: {
      name: figma.root.name,
      key: (figma as unknown as { fileKey?: string }).fileKey ?? null,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })),
    },
    styles,
    variables,
    components: components.components,
    externalComponents: evidence.externalComponents,
    screens: evidence.screens,
    observedPatterns: evidence.observedPatterns,
    extraction: {
      scope: "document",
      pagesScanned: figma.root.children.length,
      totalComponents: components.total,
      returnedComponents: components.count,
      omittedComponents: components.omittedCount,
      maxComponents: optionalNumberParam(ctx.params.maxComponents),
      totalScreens: evidence.totalScreens,
      returnedScreens: evidence.screens.length,
      omittedScreens: Math.max(0, evidence.totalScreens - evidence.screens.length),
      totalInstances: evidence.totalInstances,
      inspectedInstances: evidence.inspectedInstances,
      omittedInstances: Math.max(0, evidence.totalInstances - evidence.inspectedInstances),
      componentDepth: depth,
      screenDepth: evidence.screenDepth,
      includesScreens: includeScreens,
      includesComponentUsage: includeComponentUsage,
    },
    notes: [
      "Generated from local Figma styles, variables and components plus bounded screen/instance evidence.",
      "Component property names are the exact API keys to pass to instance.setProperties.",
      "Observed frequency patterns are evidence, not automatically approved semantic tokens.",
    ],
  };
}

interface EvidenceOptions {
  includeScreens: boolean;
  includeComponentUsage: boolean;
  screenDepth: number;
  maxScreens: number;
  maxInstances: number;
}

interface EvidenceResult {
  screens: DesignScreen[];
  externalComponents: DesignExternalComponent[];
  observedPatterns: DesignObservedPatterns;
  usageByComponentId: Map<string, DesignComponentUsage>;
  totalScreens: number;
  totalInstances: number;
  inspectedInstances: number;
  screenDepth: number;
}

interface MutableUsage {
  count: number;
  pages: Set<string>;
  screens: Set<string>;
  propertyValues: Map<string, Set<unknown>>;
}

async function collectDocumentEvidence(ctx: HandlerContext, opts: EvidenceOptions): Promise<EvidenceResult> {
  await figma.loadAllPagesAsync?.();
  const allScreenNodes = collectScreenRoots();
  const selectedScreens = opts.includeScreens ? allScreenNodes.slice(0, opts.maxScreens) : [];
  const selectedScreenIds = new Set(selectedScreens.map((node) => node.id));
  const screenComponents = new Map<string, Set<string>>();
  const screenInstanceCounts = new Map<string, number>();
  const usages = new Map<string, MutableUsage>();
  const external = new Map<string, DesignExternalComponent>();

  const instances = opts.includeComponentUsage || opts.includeScreens
    ? figma.root.findAllWithCriteria({ types: ["INSTANCE"] }) as InstanceNode[]
    : [];
  const selectedInstances = instances.slice(0, opts.maxInstances);
  const mainComponents = new Map<string, ComponentNode | null>();
  const evidenceChunkSize = 50;
  for (let start = 0; start < selectedInstances.length; start += evidenceChunkSize) {
    const chunk = selectedInstances.slice(start, start + evidenceChunkSize);
    const resolved = await Promise.all(chunk.map((instance) => mainComponentOf(instance)));
    for (let i = 0; i < chunk.length; i++) mainComponents.set(chunk[i]!.id, resolved[i] ?? null);
    ctx.progress(Math.min(start + chunk.length, selectedInstances.length), selectedInstances.length, "resolving instance components");
    await yieldToPlugin();
  }
  for (let i = 0; i < selectedInstances.length; i++) {
    const instance = selectedInstances[i]!;
    const page = pageName(instance) ?? "Unknown page";
    const screen = screenRootFor(instance);
    const screenName = screen ? `${page} / ${screen.name}` : undefined;
    if (screen && selectedScreenIds.has(screen.id)) {
      screenInstanceCounts.set(screen.id, (screenInstanceCounts.get(screen.id) ?? 0) + 1);
    }

    const main = mainComponents.get(instance.id) ?? null;
    const set = main?.parent?.type === "COMPONENT_SET" ? main.parent as ComponentSetNode : null;
    const canonical = set ?? main;
    const displayName = canonical?.name ?? instance.name;
    if (screen && selectedScreenIds.has(screen.id)) {
      const names = screenComponents.get(screen.id) ?? new Set<string>();
      names.add(displayName);
      screenComponents.set(screen.id, names);
    }

    if (opts.includeComponentUsage && main) {
      recordUsage(usages, main.id, instance, page, screenName);
      if (set) recordUsage(usages, set.id, instance, page, screenName);
    }
    if (opts.includeComponentUsage && (!canonical || canonical.remote === true)) {
      const key = canonical?.key || `unresolved:${instance.name}`;
      const existing = external.get(key) ?? {
        id: canonical?.id ?? instance.id,
        key: canonical?.key,
        name: displayName,
        type: canonical?.type === "COMPONENT_SET" ? "COMPONENT_SET" : "COMPONENT",
        componentSetId: set?.id,
        componentSetName: set?.name,
        source: canonical ? "remote-library" : "unresolved-instance",
        instanceCount: 0,
        pages: [],
        screens: [],
      } satisfies DesignExternalComponent;
      existing.instanceCount += 1;
      existing.pages = unique([...existing.pages ?? [], page]);
      if (screenName) existing.screens = unique([...existing.screens ?? [], screenName]);
      existing.propertyValues = mergeObservedPropertyValues(existing.propertyValues, instance);
      external.set(key, existing);
    }
  }

  const frequencies = makePatternCounters();
  const screens: DesignScreen[] = [];
  for (const screen of selectedScreens) {
    if ("width" in screen) addFrequency(frequencies.screenWidths, (screen as LayoutMixin).width);
    walkEvidence(screen, opts.screenDepth, (node) => collectNodePatterns(node, frequencies));
    screens.push({
      id: screen.id,
      name: screen.name,
      pageName: pageName(screen) ?? "Unknown page",
      type: screen.type,
      width: "width" in screen ? rounded((screen as LayoutMixin).width) : undefined,
      height: "height" in screen ? rounded((screen as LayoutMixin).height) : undefined,
      layoutMode: "layoutMode" in screen ? (screen as FrameNode).layoutMode : undefined,
      childCount: "children" in screen ? (screen as ChildrenMixin).children.length : 0,
      instanceCount: screenInstanceCounts.get(screen.id) ?? 0,
      components: [...(screenComponents.get(screen.id) ?? [])].slice(0, 30),
      topLevelChildren: "children" in screen
        ? (screen as ChildrenMixin).children.slice(0, 20).map((child) => ({ name: child.name, type: child.type }))
        : [],
    });
  }

  return {
    screens,
    externalComponents: [...external.values()],
    observedPatterns: patternResult(frequencies),
    usageByComponentId: new Map([...usages].map(([id, usage]) => [id, freezeUsage(usage)])),
    totalScreens: allScreenNodes.length,
    totalInstances: instances.length,
    inspectedInstances: selectedInstances.length,
    screenDepth: opts.screenDepth,
  };
}

async function resolveComponentNode(params: Record<string, unknown>): Promise<ComponentNode | ComponentSetNode> {
  const id = params.componentId ?? params.nodeId ?? params.id;
  let node: BaseNode | null = null;
  if (typeof id === "string" && id.length > 0) {
    node = await findNode(id);
  } else if (typeof params.key === "string" && params.key.length > 0) {
    await figma.loadAllPagesAsync?.();
    const key = params.key;
    node = figma.root.findOne((n) =>
      (n.type === "COMPONENT" || n.type === "COMPONENT_SET") &&
      (n as ComponentNode | ComponentSetNode).key === key,
    );
  }
  if (!node || (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET")) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      "Component not found.",
      "Pass componentId/nodeId from get_components, or a local component key.",
    );
  }
  return node as ComponentNode | ComponentSetNode;
}

async function serializeComponent(
  node: ComponentNode | ComponentSetNode,
  opts: { detail: Detail; depth: number; includeAnatomy: boolean; includeInstances: boolean },
): Promise<DesignComponent> {
  const c: DesignComponent = {
    id: node.id,
    name: node.name,
    type: node.type,
    key: node.key,
  };

  if (opts.detail !== "design" && !opts.includeAnatomy) {
    return c;
  }

  c.pageName = pageName(node);
  c.path = nodePath(node).join("/");
  c.description = stringOrUndefined((node as { description?: string }).description);
  c.componentPropertyDefinitions = readComponentPropertyDefinitions(node) ?? {};
  c.usage = usageHints(node);
  c.layout = layoutProps(node);
  c.shape = shapeProps(node);

  if (node.type === "COMPONENT") {
    c.variantProperties = plainValue(node.variantProperties) as Record<string, unknown> | null;
    if (node.parent?.type === "COMPONENT_SET") {
      c.componentSetId = node.parent.id;
      c.componentSetName = node.parent.name;
    }
    if (opts.includeInstances) {
      c.instanceCount = (await node.getInstancesAsync()).length;
    }
  } else {
    c.variantGroupProperties = plainValue(node.variantGroupProperties) as Record<string, unknown>;
    c.defaultVariantId = node.defaultVariant?.id;
    c.variants = node.children
      .filter((child): child is ComponentNode => child.type === "COMPONENT")
      .map((child) => ({
        id: child.id,
        name: child.name,
        key: child.key,
        variantProperties: plainValue(child.variantProperties),
      }));
  }

  c.textLayers = textLayers(node, opts.depth);
  c.slots = slots(node, opts.depth);
  if (opts.includeAnatomy) {
    c.anatomy = serializeTree(node, opts.detail, opts.depth);
  }
  return c;
}

function usageHints(node: ComponentNode | ComponentSetNode): string[] {
  const props = Object.keys(readComponentPropertyDefinitions(node) ?? {});
  const hints = [
    `Find it with figma.findComponent(${JSON.stringify(node.name)}).`,
    node.type === "COMPONENT_SET"
      ? `Instantiate the set/default variant with figma.instantiate(${JSON.stringify(node.id)}, { parentId, props }), or use an exact variant id.`
      : `Instantiate with figma.instantiate(${JSON.stringify(node.id)}, { parentId, props, overrides }).`,
  ];
  if (props.length) {
    hints.push(`Set component properties with exact keys: ${props.map((p) => `\`${p}\``).join(", ")}.`);
  }
  return hints;
}

function textLayers(root: BaseNode, maxDepth: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(root, maxDepth, (node, path) => {
    if (node.type !== "TEXT") return;
    const t = node as TextNode;
    out.push({
      id: t.id,
      name: t.name,
      path: path.join("/"),
      characters: t.characters.length > 160 ? t.characters.slice(0, 157) + "..." : t.characters,
      styleRefs: textStyleRefs(t),
      componentPropertyReferences: plainValue((t as { componentPropertyReferences?: unknown }).componentPropertyReferences),
      constraints: "constraints" in t ? plainValue((t as ConstraintMixin).constraints) : undefined,
    });
  });
  return out;
}

function slots(root: BaseNode, maxDepth: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(root, maxDepth, (node, path) => {
    if (node.type === "SLOT") {
      out.push({ id: node.id, name: node.name, path: path.join("/") });
    }
  });
  return out;
}

function walk(root: BaseNode, maxDepth: number, fn: (node: SceneNode, path: string[]) => void): void {
  const stack: Array<{ node: BaseNode; depth: number; path: string[] }> = [
    { node: root, depth: 0, path: [root.name] },
  ];
  while (stack.length > 0) {
    const { node, depth, path } = stack.pop()!;
    if (node.type !== "DOCUMENT" && node.type !== "PAGE") fn(node as SceneNode, path);
    if (depth >= maxDepth || !("children" in node)) continue;
    const children = [...(node as ChildrenMixin).children].reverse();
    for (const child of children) {
      stack.push({ node: child, depth: depth + 1, path: [...path, child.name] });
    }
  }
}

function layoutProps(node: BaseNode): Record<string, unknown> | undefined {
  if (!("layoutMode" in node)) return undefined;
  const f = node as FrameNode;
  const out: Record<string, unknown> = { layoutMode: f.layoutMode };
  if (f.layoutMode !== "NONE") {
    out.itemSpacing = f.itemSpacing;
    out.padding = { left: f.paddingLeft, right: f.paddingRight, top: f.paddingTop, bottom: f.paddingBottom };
    out.primaryAxisSizingMode = f.primaryAxisSizingMode;
    out.counterAxisSizingMode = f.counterAxisSizingMode;
    out.primaryAxisAlignItems = f.primaryAxisAlignItems;
    out.counterAxisAlignItems = f.counterAxisAlignItems;
  }
  if ("clipsContent" in f) out.clipsContent = f.clipsContent;
  return out;
}

function shapeProps(node: BaseNode): Record<string, unknown> | undefined {
  if (!("cornerRadius" in node)) return undefined;
  const n = node as RectangleNode;
  const out: Record<string, unknown> = {};
  const cr = n.cornerRadius;
  if (cr !== figma.mixed && cr !== 0) out.cornerRadius = cr;
  for (const key of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const) {
    const value = (n as unknown as Record<string, unknown>)[key];
    if (typeof value === "number" && value !== 0) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function getRichStyles(): Promise<NonNullable<DesignSystemKit["styles"]>> {
  const [paint, text, effect, grid] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);
  return {
    paint: paint.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description,
      paints: plainValue(s.paints),
      boundVariables: plainValue(s.boundVariables),
    })),
    text: text.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description,
      fontName: plainValue(s.fontName),
      fontSize: s.fontSize,
      lineHeight: plainValue(s.lineHeight),
      letterSpacing: plainValue(s.letterSpacing),
      paragraphSpacing: s.paragraphSpacing,
      textCase: s.textCase,
      textDecoration: s.textDecoration,
      boundVariables: plainValue(s.boundVariables),
    })),
    effect: effect.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description,
      effects: plainValue(s.effects),
      boundVariables: plainValue(s.boundVariables),
    })),
    grid: grid.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      description: s.description,
      layoutGrids: plainValue(s.layoutGrids),
      boundVariables: plainValue(s.boundVariables),
    })),
  };
}

async function getRichVariables(): Promise<NonNullable<DesignSystemKit["variables"]>> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variableNames = new Map<string, string>();
  for (const collection of collections) {
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (variable) variableNames.set(variable.id, variable.name);
    }
  }

  const out: unknown[] = [];
  for (const c of collections) {
    const modes = c.modes.map((m) => ({ id: m.modeId, name: m.name }));
    const variables: unknown[] = [];
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) continue;
      const values: Record<string, unknown> = {};
      for (const m of c.modes) {
        values[m.name] = formatVariableValue(v.valuesByMode[m.modeId], v.resolvedType, variableNames);
      }
      variables.push({
        id: v.id,
        key: v.key,
        name: v.name,
        type: v.resolvedType,
        scopes: plainValue(v.scopes),
        description: stringOrUndefined((v as { description?: string }).description),
        values,
      });
    }
    out.push({ id: c.id, key: c.key, name: c.name, defaultModeId: c.defaultModeId, modes, variables });
  }
  return { collections: out };
}

function formatVariableValue(raw: unknown, type: VariableResolvedDataType, variableNames: Map<string, string>): unknown {
  if (raw === undefined) return null;
  if (type === "COLOR" && raw && typeof raw === "object" && "r" in raw) {
    return rgbToHex(raw as RGBA);
  }
  if (raw && typeof raw === "object" && "type" in raw && "id" in raw) {
    const id = String((raw as VariableAlias).id);
    return { alias: id, name: variableNames.get(id) ?? null };
  }
  return plainValue(raw);
}

function textStyleRefs(node: TextNode): Record<string, unknown> {
  return {
    textStyleId: plainValue(node.textStyleId),
    fillStyleId: plainValue(node.fillStyleId),
    fontName: plainValue(node.fontName),
    fontSize: plainValue(node.fontSize),
    lineHeight: plainValue(node.lineHeight),
  };
}

function nodePath(node: BaseNode): string[] {
  const parts: string[] = [];
  let cur: BaseNode | null = node;
  while (cur && cur.type !== "DOCUMENT") {
    parts.push(cur.name);
    cur = cur.parent;
  }
  return parts.reverse();
}

function pageName(node: BaseNode): string | undefined {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.type === "PAGE") return cur.name;
    cur = cur.parent;
  }
  return undefined;
}

function collectScreenRoots(): SceneNode[] {
  const out: SceneNode[] = [];
  for (const page of figma.root.children) {
    for (const child of page.children) {
      if (child.type === "FRAME") {
        out.push(child);
      } else if (child.type === "SECTION") {
        const frames = child.children.filter((node): node is FrameNode => node.type === "FRAME");
        if (frames.length) out.push(...frames);
        else out.push(child);
      }
    }
  }
  return out;
}

function screenRootFor(node: BaseNode): SceneNode | null {
  let cur: BaseNode | null = node;
  let candidate: SceneNode | null = node.type !== "DOCUMENT" && node.type !== "PAGE" ? node as SceneNode : null;
  while (cur?.parent) {
    if (cur.parent.type === "PAGE") return cur.type === "DOCUMENT" || cur.type === "PAGE" ? candidate : cur as SceneNode;
    if (cur.parent.type === "SECTION" && cur.parent.parent?.type === "PAGE") return cur as SceneNode;
    if (cur.type !== "DOCUMENT" && cur.type !== "PAGE") candidate = cur as SceneNode;
    cur = cur.parent;
  }
  return candidate;
}

async function mainComponentOf(instance: InstanceNode): Promise<ComponentNode | null> {
  const asyncGetter = (instance as InstanceNode & { getMainComponentAsync?: () => Promise<ComponentNode | null> }).getMainComponentAsync;
  if (typeof asyncGetter === "function") {
    try {
      return await asyncGetter.call(instance);
    } catch {
      return null;
    }
  }
  try {
    return (instance as InstanceNode & { mainComponent?: ComponentNode | null }).mainComponent ?? null;
  } catch {
    return null;
  }
}

function recordUsage(
  usages: Map<string, MutableUsage>,
  id: string,
  instance: InstanceNode,
  page: string,
  screen: string | undefined,
): void {
  const usage = usages.get(id) ?? {
    count: 0,
    pages: new Set<string>(),
    screens: new Set<string>(),
    propertyValues: new Map<string, Set<unknown>>(),
  };
  usage.count += 1;
  usage.pages.add(page);
  if (screen) usage.screens.add(screen);
  for (const [name, raw] of Object.entries(instance.componentProperties ?? {})) {
    const prop = raw as { value?: unknown };
    const value = plainValue(prop?.value);
    if (value === undefined) continue;
    const values = usage.propertyValues.get(name) ?? new Set<unknown>();
    if (values.size < 12) values.add(typeof value === "object" ? JSON.stringify(value) : value);
    usage.propertyValues.set(name, values);
  }
  usages.set(id, usage);
}

function mergeObservedPropertyValues(
  existing: Record<string, unknown[]> | undefined,
  instance: InstanceNode,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = { ...(existing ?? {}) };
  for (const [name, raw] of Object.entries(instance.componentProperties ?? {})) {
    const value = plainValue((raw as { value?: unknown })?.value);
    if (value === undefined) continue;
    const normalized = typeof value === "object" ? JSON.stringify(value) : value;
    const values = out[name] ?? [];
    if (values.length < 12 && !values.includes(normalized)) values.push(normalized);
    out[name] = values;
  }
  return out;
}

function freezeUsage(usage: MutableUsage): DesignComponentUsage {
  const propertyValues: Record<string, unknown[]> = {};
  for (const [name, values] of usage.propertyValues) propertyValues[name] = [...values];
  return {
    instanceCount: usage.count,
    pages: [...usage.pages],
    screens: [...usage.screens],
    propertyValues,
  };
}

interface PatternCounters {
  screenWidths: Map<number, number>;
  spacing: Map<number, number>;
  padding: Map<number, number>;
  radii: Map<number, number>;
  fontSizes: Map<number, number>;
  solidFills: Map<string, number>;
}

function makePatternCounters(): PatternCounters {
  return {
    screenWidths: new Map(),
    spacing: new Map(),
    padding: new Map(),
    radii: new Map(),
    fontSizes: new Map(),
    solidFills: new Map(),
  };
}

function walkEvidence(root: SceneNode, maxDepth: number, visit: (node: SceneNode) => void): void {
  const stack: Array<{ node: SceneNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    visit(item.node);
    if (item.depth >= maxDepth || !("children" in item.node)) continue;
    for (const child of (item.node as ChildrenMixin).children) stack.push({ node: child, depth: item.depth + 1 });
  }
}

function collectNodePatterns(node: SceneNode, counters: PatternCounters): void {
  if ("layoutMode" in node) {
    const frame = node as FrameNode;
    if (frame.layoutMode !== "NONE") {
      addFrequency(counters.spacing, frame.itemSpacing);
      for (const value of [frame.paddingLeft, frame.paddingRight, frame.paddingTop, frame.paddingBottom]) {
        addFrequency(counters.padding, value);
      }
    }
  }
  if ("cornerRadius" in node) {
    const value = (node as RectangleNode).cornerRadius;
    if (typeof value === "number") addFrequency(counters.radii, value);
  }
  if (node.type === "TEXT" && typeof node.fontSize === "number") addFrequency(counters.fontSizes, node.fontSize);
  if ("fills" in node) {
    const fills = (node as GeometryMixin).fills;
    if (Array.isArray(fills)) {
      for (const fill of fills) {
        if (fill.type === "SOLID" && fill.visible !== false) {
          const hex = rgbToHex(fill.color);
          counters.solidFills.set(hex, (counters.solidFills.get(hex) ?? 0) + 1);
        }
      }
    }
  }
}

function addFrequency(map: Map<number, number>, raw: number): void {
  if (!Number.isFinite(raw)) return;
  const value = rounded(raw);
  map.set(value, (map.get(value) ?? 0) + 1);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function patternResult(counters: PatternCounters): DesignObservedPatterns {
  return {
    screenWidths: topNumeric(counters.screenWidths),
    spacing: topNumeric(counters.spacing),
    padding: topNumeric(counters.padding),
    radii: topNumeric(counters.radii),
    fontSizes: topNumeric(counters.fontSizes),
    solidFills: [...counters.solidFills]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, 16),
  };
}

function topNumeric(map: Map<number, number>): Array<{ value: number; count: number }> {
  return [...map]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value - b.value)
    .slice(0, 16);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberParam(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(8, Math.floor(value)));
}

function optionalNumberParam(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function boundedCountParam(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function markdownOptions(params: Record<string, unknown>): DesignMarkdownOptions {
  return {
    maxComponents: optionalNumberParam(params.maxComponents),
    maxVariantsPerComponent: optionalNumberParam(params.maxVariantsPerComponent),
    maxTextLayersPerComponent: optionalNumberParam(params.maxTextLayersPerComponent),
    maxOutputChars: optionalNumberParam(params.maxOutputChars),
  };
}

function yieldToPlugin(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
