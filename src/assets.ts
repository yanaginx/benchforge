import fs from 'node:fs';
import { isSea, getAsset } from 'node:sea';

/** A file shipped with the tool, by path from the project root. Inside the single-file binary it comes from the embedded copy. */
export function asset(name: string): string {
  if (isSea()) return getAsset(name, 'utf8');
  return fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
}
