export interface DesignSystemKit {
  file?: {
    name?: string;
    key?: string | null;
    page?: { id?: string; name?: string };
    pages?: Array<{ id?: string; name?: string }>;
  };
  styles?: {
    paint?: unknown[];
    text?: unknown[];
    effect?: unknown[];
    grid?: unknown[];
  };
  variables?: {
    collections?: unknown[];
  };
  components?: DesignComponent[];
  externalComponents?: DesignExternalComponent[];
  screens?: DesignScreen[];
  observedPatterns?: DesignObservedPatterns;
  extraction?: {
    scope?: "document" | "page";
    pagesScanned?: number;
    totalComponents?: number;
    returnedComponents?: number;
    omittedComponents?: number;
    maxComponents?: number;
    totalScreens?: number;
    returnedScreens?: number;
    omittedScreens?: number;
    totalInstances?: number;
    inspectedInstances?: number;
    omittedInstances?: number;
    componentDepth?: number;
    screenDepth?: number;
    includesScreens?: boolean;
    includesComponentUsage?: boolean;
  };
  notes?: string[];
}

export interface DesignComponent {
  id: string;
  name: string;
  type: string;
  key?: string;
  description?: string;
  pageName?: string;
  path?: string;
  variantProperties?: Record<string, unknown> | null;
  variantGroupProperties?: Record<string, unknown>;
  componentPropertyDefinitions?: Record<string, unknown>;
  componentSetId?: string;
  componentSetName?: string;
  defaultVariantId?: string;
  instanceCount?: number;
  anatomy?: unknown;
  layout?: Record<string, unknown>;
  shape?: Record<string, unknown>;
  variants?: Array<Record<string, unknown>>;
  textLayers?: Array<Record<string, unknown>>;
  slots?: Array<Record<string, unknown>>;
  usage?: string[];
  usageStats?: DesignComponentUsage;
}

export interface DesignComponentUsage {
  instanceCount: number;
  pages?: string[];
  screens?: string[];
  propertyValues?: Record<string, unknown[]>;
}

export interface DesignExternalComponent extends DesignComponentUsage {
  id: string;
  key?: string;
  name: string;
  type: "COMPONENT" | "COMPONENT_SET";
  componentSetId?: string;
  componentSetName?: string;
  source: "remote-library" | "unresolved-instance";
}

export interface DesignScreen {
  id: string;
  name: string;
  pageName: string;
  type: string;
  width?: number;
  height?: number;
  layoutMode?: string;
  childCount?: number;
  instanceCount?: number;
  components?: string[];
  topLevelChildren?: Array<{ name: string; type: string }>;
}

export interface DesignObservedPatterns {
  screenWidths?: Array<{ value: number; count: number }>;
  spacing?: Array<{ value: number; count: number }>;
  padding?: Array<{ value: number; count: number }>;
  radii?: Array<{ value: number; count: number }>;
  fontSizes?: Array<{ value: number; count: number }>;
  solidFills?: Array<{ value: string; count: number }>;
}

export interface DesignMarkdownOptions {
  maxComponents?: number;
  maxVariantsPerComponent?: number;
  maxTextLayersPerComponent?: number;
  maxOutputChars?: number;
}

export function renderDesignMarkdown(kit: DesignSystemKit, options: DesignMarkdownOptions = {}): string {
  const lines: string[] = [];
  const fileName = kit.file?.name || "Figma design system";
  // Child variants are already represented inside their COMPONENT_SET. Keep
  // them in structured JSON, but avoid duplicating every variant as a full
  // Markdown component entry.
  const components = canonicalComponents(kit.components ?? []);
  const limits = {
    maxComponents: finiteLimit(options.maxComponents),
    maxVariantsPerComponent: finiteLimit(options.maxVariantsPerComponent),
    maxTextLayersPerComponent: finiteLimit(options.maxTextLayersPerComponent),
    maxOutputChars: finiteLimit(options.maxOutputChars),
  };

  lines.push(`# ${fileName} Design System`);
  lines.push("");
  lines.push(`Extraction scope: ${kit.extraction?.scope === "page" ? "Current page" : "Entire document"}`);
  if (kit.file?.page?.name) lines.push(`Current page when extracted: ${kit.file.page.name}`);
  if (kit.file?.pages?.length) lines.push(`Pages discovered: ${kit.file.pages.map((p) => p.name).filter(Boolean).join(", ")}`);
  lines.push("");

  appendOverview(lines, kit);
  appendCoverage(lines, kit);
  appendColors(lines, kit);
  appendTypography(lines, kit);
  appendLayout(lines, kit);
  appendObservedPatterns(lines, kit.observedPatterns);
  appendElevation(lines, kit);
  appendShapes(lines, kit);

  lines.push("## Agent Rules");
  lines.push("- Reuse listed components before drawing equivalent new UI.");
  lines.push("- Use component properties and variants when available; use layer overrides only as a fallback.");
  lines.push("- Use variables/styles by name instead of hardcoded values when a matching token exists.");
  lines.push("- Treat node IDs as bindings to this exact Figma file. After duplicating/migrating a file, resolve by component key/name and refresh IDs before writing.");
  lines.push("- Treat frequency observations as candidates, not semantic tokens, unless a matching Figma variable/style or explicit description confirms them.");
  lines.push("- After creating or modifying UI, run `layout_audit` on the changed frame.");
  lines.push("- Treat this file as source-grounded. Fill narrative gaps only after reading screenshots, selected nodes, or additional Figma pages.");
  lines.push("");

  appendVariables(lines, kit.variables?.collections);
  appendStyles(lines, kit.styles);
  appendComponents(lines, components, limits);
  appendExternalComponents(lines, kit.externalComponents);
  appendScreens(lines, kit.screens);
  appendDoDonts(lines, kit);
  appendResponsive(lines, kit);
  appendIterationGuide(lines);
  appendKnownGaps(lines, kit);

  if (kit.notes?.length) {
    lines.push("## Notes");
    for (const note of kit.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  let markdown = trimTrailingBlank(lines).join("\n") + "\n";
  if (limits.maxOutputChars !== undefined && markdown.length > limits.maxOutputChars) {
    markdown = truncateBySection(markdown, limits.maxOutputChars);
  }
  return markdown;
}

function appendCoverage(lines: string[], kit: DesignSystemKit): void {
  const e = kit.extraction;
  lines.push("## Extraction Coverage");
  if (!e) {
    lines.push("- Coverage metadata was not supplied; treat this document as partial.");
    lines.push("");
    return;
  }
  lines.push(`- Pages scanned: ${e.pagesScanned ?? 0}`);
  lines.push(`- Local components returned: ${e.returnedComponents ?? 0}/${e.totalComponents ?? 0}`);
  lines.push(`- Screens summarized: ${e.returnedScreens ?? 0}/${e.totalScreens ?? 0}`);
  lines.push(`- Instances inspected: ${e.inspectedInstances ?? 0}/${e.totalInstances ?? 0}`);
  lines.push(`- Component anatomy depth: ${e.componentDepth ?? 0}; screen evidence depth: ${e.screenDepth ?? 0}`);
  lines.push(`- Screen evidence: ${e.includesScreens ? "included" : "not requested"}; component usage: ${e.includesComponentUsage ? "included" : "not requested"}`);
  if ((e.omittedComponents ?? 0) + (e.omittedScreens ?? 0) + (e.omittedInstances ?? 0) > 0) {
    lines.push(`- Partial extraction: ${e.omittedComponents ?? 0} component(s), ${e.omittedScreens ?? 0} screen(s), and ${e.omittedInstances ?? 0} instance(s) omitted by limits.`);
  }
  lines.push("");
  lines.push("> Evidence labels: IDs, keys, properties, values, counts, and geometry are direct Figma facts. Pattern summaries are observations from the scanned nodes. Product meaning, UX intent, and breakpoint semantics remain unknown unless explicitly named or described in Figma.");
  lines.push("");
}

function appendOverview(lines: string[], kit: DesignSystemKit): void {
  const styleCounts = {
    paint: arr(kit.styles?.paint).length,
    text: arr(kit.styles?.text).length,
    effect: arr(kit.styles?.effect).length,
    grid: arr(kit.styles?.grid).length,
  };
  const collections = arr(kit.variables?.collections);
  const variableCount = collections.reduce<number>((sum, c) => sum + arr(obj(c).variables).length, 0);
  const components = kit.components ?? [];
  const componentSets = components.filter((c) => c.type === "COMPONENT_SET").length;
  const componentNodes = components.filter((c) => c.type === "COMPONENT" && !c.componentSetId).length;
  const variantNodes = components.filter((c) => c.type === "COMPONENT" && !!c.componentSetId).length;

  lines.push("## Overview");
  lines.push(`${kit.file?.name || "This Figma file"} exposes ${componentSets} component set(s), ${componentNodes} standalone component(s), and ${variantNodes} set variant node(s), plus ${variableCount} variables across ${collections.length} collection(s) and ${styleCounts.paint + styleCounts.text + styleCounts.effect + styleCounts.grid} local styles.`);
  if (kit.extraction?.omittedComponents) {
    lines.push(`Extraction note: ${kit.extraction.omittedComponents} component(s) were omitted by the maxComponents limit. Re-run with a higher limit for a complete catalog.`);
  }
  lines.push("");
  lines.push("**Key Characteristics To Confirm:**");
  lines.push("- Primary brand colors: see the Colors section. Confirm semantic roles from screenshots before assigning brand meaning.");
  lines.push("- Type system: see Typography. Numeric/display roles must be inferred from text style names and actual UI usage.");
  lines.push("- Theme model: inspect color collection modes and page usage; do not assume light/dark behavior unless variables or screens show it.");
  lines.push("- Component reuse: components below list exact property keys where Figma exposes them.");
  lines.push("");
}

function appendVariables(lines: string[], collections: unknown[] | undefined): void {
  lines.push("## Variables");
  if (!Array.isArray(collections) || collections.length === 0) {
    lines.push("_No local variables found._");
    lines.push("");
    return;
  }
  for (const raw of collections) {
    const c = obj(raw);
    const name = str(c.name, "Collection");
    const modes = arr(c.modes).map((m) => str(obj(m).name, "")).filter(Boolean);
    lines.push(`### ${name}${modes.length ? ` (${modes.join(", ")})` : ""}`);
    const vars = arr(c.variables);
    if (!vars.length) {
      lines.push("- _No variables._");
      continue;
    }
    for (const rawVar of vars) {
      const v = obj(rawVar);
      const values = obj(v.values);
      const valueText = Object.keys(values).length
        ? Object.entries(values)
            .map(([mode, value]) => `${mode}: ${formatInline(value)}`)
            .join("; ")
        : formatInline(v.value);
      lines.push(`- \`${str(v.name, "unnamed")}\` (${str(v.type ?? v.resolvedType, "unknown")})${valueText ? ` = ${valueText}` : ""}`);
    }
  }
  lines.push("");
}

function appendColors(lines: string[], kit: DesignSystemKit): void {
  const colorVars = variableEntries(kit).filter((v) => v.type === "COLOR");
  const paintStyles = arr(kit.styles?.paint).map(obj);
  lines.push("## Colors");
  if (!colorVars.length && !paintStyles.length) {
    lines.push("_No color variables or paint styles found._");
    lines.push("");
    return;
  }

  if (colorVars.length) {
    lines.push("### Variable Colors");
    for (const group of groupByPrefix(colorVars, (v) => v.name)) {
      lines.push(`#### ${group.name}`);
      for (const v of group.items) {
        lines.push(`- **${tailName(v.name)}** (\`{${v.name}}\`): ${valuesPreview(v.values)}${v.description ? ` - ${v.description}` : ""}`);
      }
    }
  }

  if (paintStyles.length) {
    lines.push("### Paint Styles");
    for (const group of groupByPrefix(paintStyles, (s) => str(s.name, "unnamed"))) {
      lines.push(`#### ${group.name}`);
      for (const s of group.items) {
        lines.push(`- **${tailName(str(s.name, "unnamed"))}**: ${paintPreview(s.paints)}${s.description ? ` - ${s.description}` : ""}`);
      }
    }
  }
  lines.push("");
}

function appendTypography(lines: string[], kit: DesignSystemKit): void {
  const textStyles = arr(kit.styles?.text).map(obj);
  lines.push("## Typography");
  if (!textStyles.length) {
    lines.push("_No local text styles found._");
    lines.push("");
    return;
  }
  lines.push("| Token | Family | Style | Size | Line Height | Letter Spacing | Use |");
  lines.push("|---|---|---:|---:|---:|---:|---|");
  for (const s of textStyles) {
    const font = obj(s.fontName);
    lines.push(`| \`{typography.${tokenName(str(s.name, "text"))}}\` | ${str(font.family, "-")} | ${str(font.style, "-")} | ${formatInline(s.fontSize)} | ${formatInline(s.lineHeight)} | ${formatInline(s.letterSpacing)} | ${str(s.description, inferUseFromName(str(s.name, "")))} |`);
  }
  lines.push("");
  lines.push("### Typography Principles");
  lines.push("- Use the named text styles above before hardcoding font values.");
  lines.push("- If multiple number/table styles exist, reserve them for prices, counts, totals, metrics and dense tabular data.");
  lines.push("- If a font is unavailable locally, check `get_fonts` before substituting; keep size/line-height close to the extracted style.");
  lines.push("");
}

function appendLayout(lines: string[], kit: DesignSystemKit): void {
  const spacingVars = variableEntries(kit).filter((v) => v.type !== "COLOR" && /space|spacing|gap|padding|size|width|height/i.test(v.name));
  const grids = arr(kit.styles?.grid).map(obj);
  const layouts = canonicalComponents(kit.components ?? []).map((c) => ({ name: c.name, layout: obj(c.layout) })).filter((x) => Object.keys(x.layout).length);

  lines.push("## Layout");
  if (!spacingVars.length && !grids.length && !layouts.length) {
    lines.push("_No explicit spacing variables, grid styles or component layout metadata found._");
    lines.push("");
    return;
  }
  if (spacingVars.length) {
    lines.push("### Spacing & Size Tokens");
    for (const v of spacingVars) {
      lines.push(`- \`{${v.name}}\`: ${valuesPreview(v.values)}`);
    }
  }
  if (grids.length) {
    lines.push("### Grid Styles");
    for (const grid of grids) {
      lines.push(`- \`${str(grid.name, "grid")}\`: ${formatInline(grid.layoutGrids)}`);
    }
  }
  if (layouts.length) {
    lines.push("### Component Layout Patterns");
    for (const item of layouts) {
      lines.push(`- \`${item.name}\`: ${formatProps(item.layout)}`);
    }
  }
  lines.push("");
}

function appendElevation(lines: string[], kit: DesignSystemKit): void {
  const effects = arr(kit.styles?.effect).map(obj);
  lines.push("## Elevation & Depth");
  if (!effects.length) {
    lines.push("_No local effect styles found. Treat elevation as flat unless component anatomy shows shadows._");
    lines.push("");
    return;
  }
  lines.push("| Style | Effects | Variables |");
  lines.push("|---|---|---|");
  for (const e of effects) {
    lines.push(`| \`${str(e.name, "effect")}\` | ${formatInline(e.effects)} | ${bindingsPreview(e) || "-"} |`);
  }
  lines.push("");
}

function appendShapes(lines: string[], kit: DesignSystemKit): void {
  const radiusVars = variableEntries(kit).filter((v) => /radius|rounded|corner/i.test(v.name));
  const shapes = canonicalComponents(kit.components ?? []).map((c) => ({ name: c.name, shape: obj(c.shape) })).filter((x) => Object.keys(x.shape).length);

  lines.push("## Shapes");
  if (!radiusVars.length && !shapes.length) {
    lines.push("_No radius variables or component shape metadata found._");
    lines.push("");
    return;
  }
  if (radiusVars.length) {
    lines.push("### Radius Tokens");
    for (const v of radiusVars) {
      lines.push(`- \`{${v.name}}\`: ${valuesPreview(v.values)}`);
    }
  }
  if (shapes.length) {
    lines.push("### Observed Component Radii");
    for (const item of shapes) {
      lines.push(`- \`${item.name}\`: ${formatProps(item.shape)}`);
    }
  }
  lines.push("");
}

function appendStyles(lines: string[], styles: DesignSystemKit["styles"]): void {
  lines.push("## Styles");
  const groups = [
    ["Paint", styles?.paint],
    ["Text", styles?.text],
    ["Effect", styles?.effect],
    ["Grid", styles?.grid],
  ] as const;
  let any = false;
  for (const [label, items] of groups) {
    if (!Array.isArray(items) || items.length === 0) continue;
    any = true;
    lines.push(`### ${label}`);
    for (const item of items) {
      const s = obj(item);
      const bits = [stylePreview(s), bindingsPreview(s)].filter(Boolean);
      lines.push(`- \`${str(s.name, "unnamed")}\`${bits.length ? ` - ${bits.join("; ")}` : ""}`);
    }
  }
  if (!any) lines.push("_No local styles found._");
  lines.push("");
}

function appendComponents(lines: string[], components: DesignComponent[], limits: {
  maxComponents?: number;
  maxVariantsPerComponent?: number;
  maxTextLayersPerComponent?: number;
}): void {
  lines.push("## Components");
  if (!components.length) {
    lines.push("_No local components found._");
    lines.push("");
    return;
  }

  const shown = limits.maxComponents === undefined ? components : components.slice(0, limits.maxComponents);
  if (shown.length < components.length) {
    lines.push(`_Showing ${shown.length} of ${components.length} components. Re-run with a higher maxComponents limit for the full catalog._`);
    lines.push("");
  }

  for (const c of shown) {
    lines.push(`### ${c.name}`);
    lines.push(`- Type: ${c.type}${c.path ? ` (${c.path})` : ""}`);
    lines.push(`- Figma node ID: \`${c.id}\``);
    if (c.key) lines.push(`- Figma component key: \`${c.key}\``);
    if (c.pageName) lines.push(`- Source page: ${c.pageName}`);
    if (c.componentSetId) lines.push(`- Component set: ${c.componentSetName ?? "set"} (\`${c.componentSetId}\`)`);
    if (c.defaultVariantId) lines.push(`- Default variant ID: \`${c.defaultVariantId}\``);
    if (c.description) lines.push(`- Description: ${c.description}`);
    if (c.layout && Object.keys(c.layout).length) lines.push(`- Layout: ${formatProps(c.layout)}`);
    if (c.shape && Object.keys(c.shape).length) lines.push(`- Shape: ${formatProps(c.shape)}`);
    if (c.variantProperties && Object.keys(c.variantProperties).length) {
      lines.push(`- Variant: ${formatProps(c.variantProperties)}`);
    }
    const defs = obj(c.componentPropertyDefinitions);
    if (Object.keys(defs).length) {
      lines.push("- Component properties:");
      for (const [name, defRaw] of Object.entries(defs)) {
        const def = obj(defRaw);
        const options = Array.isArray(def.variantOptions)
          ? ` options=${(def.variantOptions as unknown[]).map(formatInline).join(", ")}`
          : "";
        const preferred = Array.isArray(def.preferredValues) ? ` preferred=${(def.preferredValues as unknown[]).length}` : "";
        lines.push(`  - \`${name}\`: ${str(def.type, "UNKNOWN")} default=${formatInline(def.defaultValue)}${options}${preferred}`);
      }
    }
    if (Array.isArray(c.variants) && c.variants.length) {
      lines.push("- Variants:");
      const variants = limits.maxVariantsPerComponent === undefined ? c.variants : c.variants.slice(0, limits.maxVariantsPerComponent);
      for (const v of variants) {
        const variantId = str(v.id, "");
        const variantKey = str(v.key, "");
        lines.push(`  - ${str(v.name, "variant")}${variantId ? ` — id \`${variantId}\`` : ""}${variantKey ? `, key \`${variantKey}\`` : ""}${v.variantProperties ? ` (${formatProps(obj(v.variantProperties))})` : ""}`);
      }
      if (variants.length < c.variants.length) lines.push(`  - ... ${c.variants.length - variants.length} more`);
    }
    if (Array.isArray(c.textLayers) && c.textLayers.length) {
      lines.push("- Text layers:");
      const textLayers = limits.maxTextLayersPerComponent === undefined ? c.textLayers : c.textLayers.slice(0, limits.maxTextLayersPerComponent);
      for (const t of textLayers) {
        const refs = obj(t.componentPropertyReferences);
        const constraintText = t.constraints ? ` constraints=${formatInline(t.constraints)}` : "";
        lines.push(`  - \`${str(t.path ?? t.name, "text")}\`${t.characters ? `: "${truncate(str(t.characters, ""), 120)}"` : ""}${Object.keys(refs).length ? ` refs=${formatProps(refs)}` : ""}${constraintText}`);
      }
      if (textLayers.length < c.textLayers.length) lines.push(`  - ... ${c.textLayers.length - textLayers.length} more`);
    }
    if (Array.isArray(c.slots) && c.slots.length) {
      lines.push(`- Slots: ${c.slots.map((s) => `\`${str(s.path ?? s.name, "slot")}\``).join(", ")}`);
    }
    if (c.anatomy) {
      lines.push("- Anatomy:");
      for (const row of anatomyRows(c.anatomy)) {
        lines.push(`  - ${row}`);
      }
    }
    if (Array.isArray(c.usage) && c.usage.length) {
      lines.push("- Usage:");
      for (const u of c.usage) lines.push(`  - ${u}`);
    }
    if (c.usageStats) {
      lines.push(`- Observed instances: ${c.usageStats.instanceCount}`);
      if (c.usageStats.pages?.length) lines.push(`- Used on pages: ${c.usageStats.pages.join(", ")}`);
      if (c.usageStats.screens?.length) lines.push(`- Used in screens: ${c.usageStats.screens.join(", ")}`);
      if (c.usageStats.propertyValues && Object.keys(c.usageStats.propertyValues).length) {
        lines.push("- Observed property values:");
        for (const [name, values] of Object.entries(c.usageStats.propertyValues)) {
          lines.push(`  - \`${name}\`: ${values.map(formatInline).join(", ")}`);
        }
      }
    }
    lines.push("- Instantiate:");
    lines.push("```js");
    lines.push(`await figma.instantiate(${JSON.stringify(c.id)}, {`);
    lines.push("  parentId: screen.id,");
    const defaults = componentPropDefaults(defs);
    if (Object.keys(defaults).length) lines.push(`  props: ${JSON.stringify(defaults, null, 2).replace(/\n/g, "\n  ")},`);
    lines.push("});");
    lines.push("```");
    lines.push("");
  }
}

function componentPropDefaults(defs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(defs)) {
    const value = obj(raw).defaultValue;
    if (typeof value === "string" || typeof value === "boolean") out[name] = value;
  }
  return out;
}

function appendExternalComponents(lines: string[], components: DesignExternalComponent[] | undefined): void {
  lines.push("## External & Library Components");
  if (!components?.length) {
    lines.push("_No remote-library component instances were identified in the inspected instance range._");
    lines.push("");
    return;
  }
  for (const c of components) {
    lines.push(`### ${c.name}`);
    lines.push(`- Source: ${c.source}`);
    lines.push(`- Type: ${c.type}`);
    lines.push(`- Imported/local node ID: \`${c.id}\``);
    if (c.key) lines.push(`- Library key: \`${c.key}\``);
    if (c.componentSetId) lines.push(`- Component set: ${c.componentSetName ?? "set"} (\`${c.componentSetId}\`)`);
    lines.push(`- Observed instances: ${c.instanceCount}`);
    if (c.pages?.length) lines.push(`- Used on pages: ${c.pages.join(", ")}`);
    if (c.screens?.length) lines.push(`- Used in screens: ${c.screens.join(", ")}`);
    if (c.propertyValues && Object.keys(c.propertyValues).length) {
      lines.push("- Observed property values:");
      for (const [name, values] of Object.entries(c.propertyValues)) lines.push(`  - \`${name}\`: ${values.map(formatInline).join(", ")}`);
    }
    lines.push("- Evidence limitation: library anatomy is not claimed unless it was imported separately with `get_library_component`.");
    lines.push("");
  }
}

function appendScreens(lines: string[], screens: DesignScreen[] | undefined): void {
  lines.push("## Screen Evidence");
  if (!screens?.length) {
    lines.push("_No screen summaries were extracted. Do not infer page composition or responsive behavior from the component catalog alone._");
    lines.push("");
    return;
  }
  for (const s of screens) {
    const size = s.width !== undefined && s.height !== undefined ? `${s.width}×${s.height}` : "unknown size";
    lines.push(`### ${s.pageName} / ${s.name}`);
    lines.push(`- Figma node ID: \`${s.id}\``);
    lines.push(`- Direct evidence: ${s.type}, ${size}${s.layoutMode ? `, layout=${s.layoutMode}` : ""}, ${s.childCount ?? 0} direct child(ren), ${s.instanceCount ?? 0} component instance(s).`);
    if (s.components?.length) lines.push(`- Components observed: ${s.components.join(", ")}`);
    if (s.topLevelChildren?.length) lines.push(`- Top-level composition: ${s.topLevelChildren.map((c) => `${c.name} (${c.type})`).join(" → ")}`);
    lines.push("");
  }
}

function appendObservedPatterns(lines: string[], patterns: DesignObservedPatterns | undefined): void {
  lines.push("## Observed Layout & Visual Patterns");
  if (!patterns || !Object.values(patterns).some((v) => Array.isArray(v) && v.length)) {
    lines.push("_No repeated raw-node patterns were extracted. Token/style sections remain authoritative where present._");
    lines.push("");
    return;
  }
  lines.push("These are frequency observations, not automatically approved design tokens:");
  appendFrequency(lines, "Screen widths", patterns.screenWidths, "px");
  appendFrequency(lines, "Auto-layout gaps", patterns.spacing, "px");
  appendFrequency(lines, "Padding values", patterns.padding, "px");
  appendFrequency(lines, "Corner radii", patterns.radii, "px");
  appendFrequency(lines, "Font sizes", patterns.fontSizes, "px");
  if (patterns.solidFills?.length) lines.push(`- Solid fills: ${patterns.solidFills.map((x) => `${x.value} (×${x.count})`).join(", ")}`);
  lines.push("");
}

function appendFrequency(lines: string[], label: string, values: Array<{ value: number; count: number }> | undefined, suffix: string): void {
  if (values?.length) lines.push(`- ${label}: ${values.map((x) => `${x.value}${suffix} (×${x.count})`).join(", ")}`);
}

function appendDoDonts(lines: string[], kit: DesignSystemKit): void {
  const hasColorVars = variableEntries(kit).some((v) => v.type === "COLOR");
  const hasProps = (kit.components ?? []).some((c) => Object.keys(obj(c.componentPropertyDefinitions)).length > 0);
  lines.push("## Do's and Don'ts");
  lines.push("### Do");
  lines.push("- Do use the extracted component names and property keys exactly as written.");
  if (hasProps) lines.push("- Do configure instances with component properties before applying layer-name overrides.");
  if (hasColorVars) lines.push("- Do bind or reference color variables instead of hardcoding equivalent hex values.");
  lines.push("- Do run `layout_audit` after non-trivial edits and fix overflow/clipping structurally.");
  lines.push("");
  lines.push("### Don't");
  lines.push("- Don't create look-alike components when an equivalent component is listed above.");
  lines.push("- Don't infer brand semantics from token names alone; confirm with actual screens or screenshots.");
  lines.push("- Don't use hidden/truncated text layers as stable selectors unless component properties expose the same control.");
  lines.push("- Don't treat this document as exhaustive when Known Gaps lists missing pages, screenshots or anatomy.");
  lines.push("");
}

function appendResponsive(lines: string[], kit: DesignSystemKit): void {
  const constrainedTextLayers = (kit.components ?? [])
    .flatMap((c) => c.textLayers ?? [])
    .filter((t) => t.constraints);
  const grids = arr(kit.styles?.grid);
  lines.push("## Responsive Evidence");
  if (!constrainedTextLayers.length && !grids.length) {
    lines.push("_No explicit layout grid styles or child constraints were extracted. Breakpoints and responsive transformations are unknown; confirm them from matched screen variants before implementation._");
    lines.push("");
    return;
  }
  if (grids.length) {
    lines.push("- Layout grid styles exist; map these to implementation breakpoints only after checking target frames.");
  }
  if (constrainedTextLayers.length) {
    lines.push("- Some component children expose Figma constraints. Preserve those resize rules when recreating components.");
  }
  lines.push("- Frame widths are observations, not breakpoints. Only document a responsive transformation when matching screens or explicit constraints support it.");
  lines.push("");
}

function appendIterationGuide(lines: string[]): void {
  lines.push("## Iteration Guide");
  lines.push("1. Start from the Figma IDs/keys in this document, then confirm the chosen binding with `get_component` before a large write.");
  lines.push("2. Use exact component property keys from this file in `figma.instantiate(..., { props })`; use a variant ID when the desired set variant is explicit.");
  lines.push("3. Use layer overrides only when a desired change has no component property.");
  lines.push("4. For code implementation, map Figma variables/styles to design tokens first, then compose components.");
  lines.push("5. After generating or editing UI, run `layout_audit`; after major visual changes, take a screenshot for human review.");
  lines.push("");
}

function appendKnownGaps(lines: string[], kit: DesignSystemKit): void {
  const gaps: string[] = [];
  if (!arr(kit.styles?.text).length) gaps.push("No local text styles were found, so typography roles may need manual extraction from selected frames.");
  if (!variableEntries(kit).some((v) => v.type === "COLOR")) gaps.push("No color variables were found; color semantics may be available only through paint styles or raw node fills.");
  if (!(kit.components ?? []).some((c) => Object.keys(obj(c.componentPropertyDefinitions)).length > 0)) gaps.push("No component property definitions were found; component customization may rely on layer overrides.");
  if (!kit.components?.some((c) => c.anatomy)) gaps.push("Component anatomy was not included. Re-run with `includeAnatomy:true` for subtree-level inspection.");
  if (kit.extraction?.omittedComponents) gaps.push(`${kit.extraction.omittedComponents} component(s) were omitted by extraction limits.`);
  if (kit.extraction?.omittedScreens) gaps.push(`${kit.extraction.omittedScreens} screen(s) were omitted by extraction limits.`);
  if (kit.extraction?.omittedInstances) gaps.push(`${kit.extraction.omittedInstances} instance(s) were omitted by extraction limits; usage counts may be partial.`);
  if (!kit.extraction?.includesScreens) gaps.push("Screen evidence was not included, so page composition, hierarchy and responsive behavior are unknown.");
  if (kit.externalComponents?.length) gaps.push("Remote-library components were observed through instances; their full anatomy requires `get_library_component` with an enabled published library.");
  lines.push("## Known Gaps");
  if (!gaps.length) {
    lines.push("- No bounded extraction gaps were reported. UX intent and semantics still require explicit Figma descriptions or human confirmation.");
  } else {
    for (const gap of gaps) lines.push(`- ${gap}`);
  }
  lines.push("");
}

function anatomyRows(root: unknown): string[] {
  const rows: string[] = [];
  const stack: Array<{ node: Record<string, unknown>; depth: number; path: string[] }> = [];
  const rootNode = obj(root);
  if (!Object.keys(rootNode).length) return rows;
  stack.push({ node: rootNode, depth: 0, path: [str(rootNode.name, "node")] });
  while (stack.length) {
    const { node, depth, path } = stack.pop()!;
    const bits: string[] = [];
    if (node.w !== undefined && node.h !== undefined) bits.push(`${formatInline(node.w)}x${formatInline(node.h)}`);
    if (node.layoutMode) bits.push(`layout=${formatInline(node.layoutMode)}`);
    if (node.fill) bits.push(`fill=${formatInline(node.fill)}`);
    if (node.characters) bits.push(`text="${truncate(str(node.characters, ""), 80)}"`);
    if (node.componentPropertyReferences) bits.push(`refs=${formatInline(node.componentPropertyReferences)}`);
    rows.push(`${"  ".repeat(depth)}\`${path.join("/")}\` (${str(node.type, "NODE")}${bits.length ? `; ${bits.join("; ")}` : ""})`);
    const children = arr(node.children).map(obj).filter((child) => Object.keys(child).length > 0).reverse();
    for (const child of children) {
      stack.push({ node: child, depth: depth + 1, path: [...path, str(child.name, "node")] });
    }
  }
  return rows;
}

interface VariableEntry {
  name: string;
  type: string;
  values: Record<string, unknown>;
  description?: string;
  collection: string;
}

function variableEntries(kit: DesignSystemKit): VariableEntry[] {
  const out: VariableEntry[] = [];
  for (const rawCollection of arr(kit.variables?.collections)) {
    const collection = obj(rawCollection);
    const collectionName = str(collection.name, "Variables");
    for (const rawVar of arr(collection.variables)) {
      const v = obj(rawVar);
      out.push({
        name: str(v.name, "unnamed"),
        type: str(v.type ?? v.resolvedType, "unknown"),
        values: obj(v.values),
        description: typeof v.description === "string" ? v.description : undefined,
        collection: collectionName,
      });
    }
  }
  return out;
}

function groupByPrefix<T>(items: T[], nameOf: (item: T) => string): Array<{ name: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = nameOf(item);
    const group = name.includes("/") ? name.split("/")[0] || "Other" : "Other";
    const bucket = groups.get(group) ?? [];
    bucket.push(item);
    groups.set(group, bucket);
  }
  return [...groups.entries()].map(([name, groupItems]) => ({ name, items: groupItems }));
}

function tailName(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

function valuesPreview(values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return entries.map(([mode, value]) => `${mode}: ${formatInline(value)}`).join("; ");
}

function paintPreview(value: unknown): string {
  const paints = arr(value);
  if (!paints.length) return "";
  return paints.map((paint) => {
    const p = obj(paint);
    if (p.type === "SOLID") {
      const color = p.color ?? p.boundVariables ?? p;
      const opacity = typeof p.opacity === "number" && p.opacity !== 1 ? ` @ ${p.opacity}` : "";
      return `SOLID ${formatInline(color)}${opacity}`;
    }
    return str(p.type, formatInline(p));
  }).join(", ");
}

function tokenName(name: string): string {
  return name
    .trim()
    .replace(/[#{}]/g, "")
    .replace(/[^a-zA-Z0-9/._-]+/g, "-")
    .replace(/\/+/g, ".")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "text";
}

function inferUseFromName(name: string): string {
  if (/hero|display/i.test(name)) return "Display headings";
  if (/title|heading|h[1-6]/i.test(name)) return "Section headings";
  if (/button|cta/i.test(name)) return "Button labels";
  if (/caption|label|meta/i.test(name)) return "Labels and metadata";
  if (/body|paragraph|copy/i.test(name)) return "Body copy";
  return "Confirm usage from component/page context";
}

function finiteLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function stylePreview(s: Record<string, unknown>): string {
  if (Array.isArray(s.paints) && s.paints.length) return `paints=${formatInline(s.paints)}`;
  if (s.fontName || s.fontSize) return `font=${formatInline(s.fontName)} ${formatInline(s.fontSize)}`.trim();
  if (Array.isArray(s.effects) && s.effects.length) return `effects=${formatInline(s.effects)}`;
  if (Array.isArray(s.layoutGrids) && s.layoutGrids.length) return `grids=${formatInline(s.layoutGrids)}`;
  return "";
}

function bindingsPreview(s: Record<string, unknown>): string {
  const bindings = obj(s.boundVariables);
  if (!Object.keys(bindings).length) return "";
  return `variables=${Object.entries(bindings).map(([k, v]) => `${k}:${formatInline(v)}`).join(", ")}`;
}

function formatProps(props: Record<string, unknown>): string {
  return Object.entries(props).map(([k, v]) => `${k}=${formatInline(v)}`).join(", ");
}

function formatInline(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function canonicalComponents(components: DesignComponent[]): DesignComponent[] {
  return components.filter((component) => component.type !== "COMPONENT" || !component.componentSetId);
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Keep Markdown structurally valid when an output limit is requested. */
function truncateBySection(markdown: string, maxChars: number): string {
  const suffix = "\n## Output Limit\n- Complete sections were omitted to preserve valid Markdown. Re-run with a larger `maxOutputChars`, request fewer components/screens, or inspect `get_design_system_kit` for the full structured source.\n";
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars);
  const sections = markdown.split(/(?=\n## )/);
  let out = "";
  let omitted = 0;
  for (const section of sections) {
    if (out.length + section.length + suffix.length <= maxChars) out += section;
    else omitted++;
  }
  return `${out.trimEnd()}${suffix.replace("Complete sections", `${omitted} complete section(s)`)}`;
}
