import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function resolveProjectPath(path) {
  return resolve(projectRoot, path);
}
