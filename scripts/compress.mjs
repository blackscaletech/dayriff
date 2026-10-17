import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const directory = 'dist/client/assets';
for (const name of await readdir(directory)) {
  if (!/\.(?:js|css|svg)$/.test(name)) continue;
  const path = join(directory, name);
  const contents = await readFile(path);
  if (contents.length < 1024) continue;
  const [br, compressed] = await Promise.all([
    brotli(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gz(contents, { level: 9 }),
  ]);
  await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, compressed)]);
}
