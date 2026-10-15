export default {
  ignorePatterns: [
    "bun/",
    "agent/git/",
    "agent/sessions/",
    // Managed by herdr; reinstalling the integration overwrites it.
    "agent/extensions/herdr-agent-state.ts",
  ],
};
