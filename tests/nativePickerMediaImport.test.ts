import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AssetLibraryStore } from '../src/main/assetLibraryStore';
import { ProjectStore } from '../src/main/projectStore';
import { TimelineIpcService } from '../src/main/timelineIpcService';
import { createMp4MediaFixture, type Mp4MediaFixture } from './helpers/mediaFixtures';

let fixture: Mp4MediaFixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('native picker media import', () => {
  it('returns an empty successful import without persisting assets when the picker is canceled', async () => {
    // Given
    const mediaFixture = await createMp4MediaFixture();
    fixture = mediaFixture;
    const root = join(mediaFixture.directory, 'projects');
    const projects = new ProjectStore(root);
    const project = await projects.create({ name: 'Canceled picker' });
    const service = new TimelineIpcService({
      projects,
      assets: new AssetLibraryStore(root, projects),
      selectMediaFiles: async () => ({ canceled: true, filePaths: [] })
    });

    // When
    const imported = await service.importProjectAssets({ projectId: project.id });

    // Then
    expect(imported).toEqual({ ok: true, value: { assets: [] } });
    expect((await projects.open(project.id))?.assets).toEqual([]);
  });

  it('copies a real MP4 into project storage without exposing or retaining dependence on its source path', async () => {
    // Given
    const mediaFixture = await createMp4MediaFixture();
    fixture = mediaFixture;
    const sourceBytes = await readFile(mediaFixture.filePath);
    const root = join(mediaFixture.directory, 'projects');
    const projects = new ProjectStore(root);
    const project = await projects.create({ name: 'Real MP4 import' });
    const service = new TimelineIpcService({
      projects,
      assets: new AssetLibraryStore(root, projects),
      selectMediaFiles: async () => ({ canceled: false, filePaths: [mediaFixture.filePath] })
    });

    // When
    const imported = await service.importProjectAssets({ projectId: project.id });

    // Then
    if (!imported.ok) {
      throw new Error(`Expected MP4 import to succeed: ${imported.error.code} ${imported.error.message}`);
    }
    const asset = imported.value.assets[0];
    if (asset === undefined) {
      throw new Error('Expected one imported MP4 asset.');
    }
    expect(imported.value.assets).toHaveLength(1);
    expect(asset).toMatchObject({
      displayName: 'fixture.mp4',
      projectRelativePath: `assets/${asset.id}/original.mp4`,
      kind: 'video',
      mimeType: 'video/mp4',
      byteLength: sourceBytes.byteLength,
      metadata: null
    });
    expect(JSON.stringify(imported)).not.toContain(mediaFixture.filePath);
    expect(JSON.stringify(imported)).not.toContain(mediaFixture.directory);
    expect((await projects.open(project.id))?.assets).toEqual([asset]);
    const persistedPath = join(root, project.id, asset.projectRelativePath);
    await expect(readFile(persistedPath)).resolves.toEqual(sourceBytes);

    await writeFile(mediaFixture.filePath, Buffer.alloc(sourceBytes.byteLength, 0x7f));
    await expect(readFile(persistedPath)).resolves.toEqual(sourceBytes);
  });

  it('imports a PNG selected from the image-only Editing picker as a project image asset', async () => {
    const mediaFixture = await createMp4MediaFixture();
    fixture = mediaFixture;
    const imagePath = join(mediaFixture.directory, 'character.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imagePath, imageBytes);
    const root = join(mediaFixture.directory, 'projects');
    const projects = new ProjectStore(root);
    const project = await projects.create({ name: 'Character references' });
    let pickerInput: unknown;
    const service = new TimelineIpcService({
      projects,
      assets: new AssetLibraryStore(root, projects),
      selectMediaFiles: async (input) => {
        pickerInput = input;
        return { canceled: false, filePaths: [imagePath] };
      }
    });

    const imported = await service.importProjectAssets({ projectId: project.id, acceptedKinds: ['image'] });

    expect(pickerInput).toMatchObject({ acceptedKinds: ['image'] });
    if (!imported.ok) throw new Error(`Expected PNG import to succeed: ${imported.error.message}`);
    expect(imported.value.assets).toHaveLength(1);
    const asset = imported.value.assets[0];
    expect(asset).toMatchObject({
      displayName: 'character.png',
      kind: 'image',
      mimeType: 'image/png',
      metadata: null
    });
    if (asset === undefined) throw new Error('Expected one imported PNG asset.');
    await expect(readFile(join(root, project.id, asset.projectRelativePath))).resolves.toEqual(imageBytes);
  });

  it('rejects a real MP4 mixed with an unsupported selection atomically and without exposing paths', async () => {
    // Given
    const mediaFixture = await createMp4MediaFixture();
    fixture = mediaFixture;
    const unsupportedPath = join(mediaFixture.directory, 'notes.txt');
    await writeFile(unsupportedPath, 'not media');
    const root = join(mediaFixture.directory, 'projects');
    const projects = new ProjectStore(root);
    const project = await projects.create({ name: 'Atomic native picker import' });
    const service = new TimelineIpcService({
      projects,
      assets: new AssetLibraryStore(root, projects),
      selectMediaFiles: async () => ({ canceled: false, filePaths: [mediaFixture.filePath, unsupportedPath] })
    });

    // When
    const imported = await service.importProjectAssets({ projectId: project.id });

    // Then
    expect(imported).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'A selected media file is not supported.' }
    });
    expect(JSON.stringify(imported)).not.toContain(mediaFixture.filePath);
    expect(JSON.stringify(imported)).not.toContain(unsupportedPath);
    expect(JSON.stringify(imported)).not.toContain(mediaFixture.directory);
    expect((await projects.open(project.id))?.assets).toEqual([]);
  });
});
