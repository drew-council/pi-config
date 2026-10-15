export default {
  printWidth: 120,
  // Keep key order as written by bun and pi.
  sortPackageJson: false,
  ignorePatterns: [
    // Only code and JSON are formatted; oxfmt would renumber the intentionally gapped
    // lists in skills and prompts.
    "*.md",
    "bun/",
    "agent/git/",
    "agent/sessions/",
    // Managed by herdr; reinstalling the integration overwrites it.
    "agent/extensions/herdr-agent-state.ts",
    // Rewritten by pi; treefmt formats it with scripts/format-pi-settings.ts instead.
    "agent/settings.json",
  ],
};
