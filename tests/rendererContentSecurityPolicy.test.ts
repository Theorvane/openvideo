import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const rootIndexHtml = readFileSync('index.html', 'utf8');

describe('renderer content security policy', () => {
  it('Given renderer media assets, When CSP is read, Then media-src permits video-tool-asset alongside existing sources', () => {
    expect(rootIndexHtml).toMatch(/media-src[^;]*'self'[^;]*blob:[^;]*video-tool-asset:[^;]*/);
  });

  it('allows confined project images to load through the same path-free asset protocol', () => {
    expect(rootIndexHtml).toMatch(/img-src[^;]*'self'[^;]*data:[^;]*video-tool-asset:[^;]*/);
  });
});
