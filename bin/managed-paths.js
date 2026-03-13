// Files tightly coupled to the package version that are auto-updated by init.
// These live in the user's project because GitHub/Docker/Next.js require them at specific paths,
// but they shouldn't drift from the package version.
// Paths ending with '/' are directories (all contents are managed).
export const MANAGED_PATHS = [
  '.github/workflows/',

  'docker-compose.yml',
  '.dockerignore',
  '.gitignore',
  'CLAUDE.md',
];

export function isManaged(relPath) {
  return MANAGED_PATHS.some(p => relPath === p || relPath.startsWith(p));
}
