// The pinned CLI unconditionally rewrites its empty generated Loader root.
// Accept only its first byte-identical write to the already provisioned file.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const path = '/opt/office-home/profiles/web/cordis.yml';
const expected = fs.readFileSync(path);
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (target, data, options) => {
  if (target !== path) return writeFileSync(target, data, options);
  if (options !== undefined || !Buffer.from(data).equals(expected)) throw new Error('Generated DSH root differs from the locked image');
  fs.writeFileSync = writeFileSync;
  syncBuiltinESMExports();
};
syncBuiltinESMExports();
