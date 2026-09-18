/**
 * The two editions of Reqwise Figma MCP, and what a free-edition caller is
 * told when it reaches for a Pro feature.
 *
 * This file ships in BOTH editions on purpose: the free edition must be able
 * to say "that is a Pro feature, here is where to get it" instead of a bare
 * "unknown tool", which reads as a bug. It names features, never how they work.
 */

export const PRO_URL = "https://ai4ba.com/figma-mcp";
export const FREE_REPO_URL = "https://github.com/hoangpm96/reqwise-figma-mcp";

/** "free" in the open-source export, "pro" here. The export rewrites this line. */
export const EDITION: "free" | "pro" = "free";

/** MCP tools that exist only in Pro. */
export const PRO_TOOLS = ["figma_design_system", "figma_record"] as const;

/** figma_diagram kinds that exist only in Pro. */
export const PRO_DIAGRAM_KINDS = ["journey", "persona", "usecase"] as const;

/** Plugin operations (figma_read ops and figma.* write methods) that exist only in Pro. */
export const PRO_OPERATIONS = [
  "audit_design_system",
  "a11y_audit",
  "responsive_audit",
  "list_demos",
  "get_demo_spec",
  "find_component",
  "find_or_create_component",
  "instantiate",
  "create_variants",
  "arrange_component_set",
  "set_component_description",
  "add_component_property",
  "edit_component_property",
  "delete_component_property",
  "componentize",
  "get_instance_overrides",
  "set_instance_overrides",
  "set_instance_properties",
  "expose_nested_instance",
  "detach_instance",
  "reset_instance_overrides",
  "apply_design_system",
  "create_usecase",
  "create_journey",
  "create_persona",
  "generate_design_system",
  "build_demo",
  "delete_demo",
  "play_demo",
] as const;

/** figma.* sandbox methods that exist only in Pro (camelCase names agents call). */
export const PRO_METHODS = [
  "findComponent",
  "findOrCreateComponent",
  "instantiate",
  "createVariants",
  "arrangeComponentSet",
  "setComponentDescription",
  "addComponentProperty",
  "editComponentProperty",
  "deleteComponentProperty",
  "componentize",
  "getInstanceOverrides",
  "setInstanceOverrides",
  "setInstanceProperties",
  "setProperties",
  "exposeNestedInstance",
  "detachInstance",
  "resetInstanceOverrides",
  "matchMainValues",
  "applyDesignSystem",
  "buildDemo",
  "playDemo",
  "deleteDemo",
  "listDemos",
  "getDemoSpec",
  "loadAvatar",
] as const;

export function isProFeature(name: string): boolean {
  return (
    (PRO_TOOLS as readonly string[]).includes(name) ||
    (PRO_DIAGRAM_KINDS as readonly string[]).includes(name) ||
    (PRO_OPERATIONS as readonly string[]).includes(name) ||
    (PRO_METHODS as readonly string[]).includes(name)
  );
}

/** The message a free-edition caller gets for a Pro feature. */
export function proFeatureMessage(name: string): { message: string; hint: string } {
  return {
    message: `"${name}" is a Reqwise Figma MCP Pro feature and is not included in the free edition.`,
    hint: `Tell the user it needs Pro: ${PRO_URL}. Everything in the free edition keeps working without it.`,
  };
}
