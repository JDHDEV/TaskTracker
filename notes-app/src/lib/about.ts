// Static About-dialog metadata. Extracted so the constants have one home and a
// pure unit to test (see about.test.ts). The version is read at runtime via
// api.getAppVersion() (drift-proof against package.json), not stored here.
export const ABOUT = {
  name: "worknotes",
  tagline: "Local-first notes and tasks, refined with AI.",
  repoUrl: "https://github.com/JDHDEV/TaskTracker",
} as const;
