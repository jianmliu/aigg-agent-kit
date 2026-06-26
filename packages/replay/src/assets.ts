import { fileURLToPath } from 'node:url';

/** Filesystem path to the static viewer dir, for hosts that want to serve it. */
export function viewerDir(): string {
  return fileURLToPath(new URL('../viewer', import.meta.url));
}
