// The LUNA Builder SDK for Node, from the same bundle the panel loads (vendor/luna.global.js), so
// the server and the tests need nothing from outside this folder.

import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const bundle = new URL('../vendor/luna.global.js', import.meta.url);
if (!globalThis.Luna) runInThisContext(readFileSync(bundle, 'utf8'), { filename: bundle.pathname });

export const Luna = globalThis.Luna;
