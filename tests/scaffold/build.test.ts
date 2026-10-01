import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('installable extension build', () => {
  it('provides a manifest and every declared entry point', () => {
    expect(existsSync('dist/manifest.json')).toBe(true);
    const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.toSorted()).toEqual(['downloads', 'storage']);
    expect(manifest.host_permissions).toEqual(['https://www.instagram.com/*']);
    expect(manifest.content_scripts[0].matches).toEqual(['https://www.instagram.com/*']);
    expect(manifest.background.type).toBe('module');
    const entries: string[] = [manifest.background.service_worker, ...manifest.content_scripts[0].js,
      ...Object.values(manifest.icons) as string[], 'library.html'];
    for (const entry of entries) expect(existsSync(join('dist', entry)), entry).toBe(true);
  });

  it('executes the content entry as a self-contained classic script', () => {
    expect(existsSync('dist/content.js')).toBe(true);
    const content = readFileSync('dist/content.js', 'utf8');
    expect(() => new Script(content)).not.toThrow();
    expect(content).not.toMatch(/(?:from\s*|import\s*\()\s*["'](?:https?:|react)/);
  });
});
