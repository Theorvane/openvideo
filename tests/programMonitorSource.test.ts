import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PROGRAM_MONITOR_SOURCE_URL = new URL('../src/renderer/src/editor/ProgramMonitor.tsx', import.meta.url);

describe('program monitor source regressions', () => {
  it('keeps active video previews audible so synced clip volume is effective', async () => {
    const source = await readFile(PROGRAM_MONITOR_SOURCE_URL, 'utf8');

    expect(source).not.toContain('muted={activePlaybackClip !== null}');
    expect(source).not.toMatch(/<video[^>]*\smuted=/s);
    expect(source).toContain('syncTimelineMediaVolume({ media: mediaRef.current, volume: mediaVolume })');
  });

  it('renders imported still images as images instead of trying to decode them as audio', async () => {
    const source = await readFile(PROGRAM_MONITOR_SOURCE_URL, 'utf8');

    expect(source).toContain("asset.kind === 'image'");
    expect(source).toMatch(/<img[^>]*src=\{previewLoadState\.url\}/s);
    expect(source).toContain("? 'Image'");
  });
});
