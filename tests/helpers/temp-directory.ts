import {mkdir, mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const privateDirectory = fileURLToPath(new URL('../../.private/', import.meta.url));

export async function createTestDirectory(prefix: string): Promise<string> {
  await mkdir(privateDirectory, {recursive: true, mode: 0o700});
  return mkdtemp(join(privateDirectory, prefix));
}
