import { build } from 'vite';

await build({ configFile: 'vite.config.ts' });
await build({ configFile: 'vite.content.config.ts' });
await build({ configFile: 'vite.bridge.config.ts' });
