import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  // Matches package.json engines. Raised from node18 once a direct prod
  // dependency (@yawlabs/mcp-compliance) began requiring node>=20 -- the
  // package could not actually run on 18 while still claiming to.
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { '__VERSION__': JSON.stringify(version) },
});
