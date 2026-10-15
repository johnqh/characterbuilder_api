import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Prefer sibling source locally; else the published @sudobility/characterbuilder_types.
const typesSrc = fileURLToPath(
  new URL('../characterbuilder_types/src/index.ts', import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: existsSync(typesSrc)
      ? { '@sudobility/characterbuilder_types': typesSrc }
      : {},
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // consumables_service's published dist uses a directory import ('./schema')
    // that Node ESM rejects but Bun/Vite resolve — inline it so Vite transforms it.
    server: { deps: { inline: [/@sudobility\/consumables_service/] } },
  },
});
