import { describe, expect, it } from 'vitest';

import {
  assetsNeedingMetadata,
  filterPendingAssetsForDock,
  getDefaultEditorDockTabs,
  getDefaultEditorLeftDockTabId,
  getNextEditorDockTabId
} from '../src/renderer/src/editor/dockTabs';
import { createInitialTimeline } from '../src/shared/timelineLogic';
import type { LocalProjectSnapshot, MediaAsset } from '../src/shared/timelineTypes';
import { createEmptyAiProjectDocument } from '../src/shared/aiProjectDomain';

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    byteLength: 1_024,
    createdAt: '2026-07-20T10:00:00.000Z',
    displayName: 'take.webm',
    id: 'asset-1',
    kind: 'video',
    metadata: { durationMs: 4_000, width: 1_920, height: 1_080 },
    mimeType: 'video/webm',
    projectRelativePath: 'assets/asset-1/original.webm',
    updatedAt: '2026-07-20T10:00:00.000Z',
    ...overrides
  };
}

function makeProject(overrides: Partial<LocalProjectSnapshot> = {}): LocalProjectSnapshot {
  return {
    assets: [
      makeAsset({ id: 'asset-ready', displayName: 'ready.webm' }),
      makeAsset({ id: 'asset-pending', displayName: 'pending.webm', metadata: null })
    ],
    createdAt: '2026-07-20T10:00:00.000Z',
    id: 'project-1',
    name: 'Launch reel',
    schemaVersion: 4,
    ai: createEmptyAiProjectDocument(),
    timeline: createInitialTimeline(),
    updatedAt: '2026-07-20T10:00:00.000Z',
    ...overrides
  };
}

describe('editor dock tabs', () => {
  it('returns stable left project/media and inspector selection/asset defaults', () => {
    // Given
    const project = makeProject();

    // When
    const dockTabs = getDefaultEditorDockTabs(project);

    // Then
    expect(dockTabs.left.map((tab) => tab.id)).toEqual(['project', 'media']);
    expect(dockTabs.left.map((tab) => tab.label)).toEqual(['Project', 'Media']);
    // Project settings live on the workspace tab line, not in the inspector.
    expect(dockTabs.inspector.map((tab) => tab.id)).toEqual(['selection', 'asset']);
    expect(dockTabs.inspector.map((tab) => tab.label)).toEqual(['Selection', 'Asset']);
  });

  it('moves focus across enabled tabs with wrap, Home, and End while skipping disabled tabs', () => {
    // Given
    const dockTabs = getDefaultEditorDockTabs(makeProject());
    const tabs = [
      ...dockTabs.left,
      { id: 'inspector', label: 'Inspector', disabled: true },
      ...dockTabs.inspector
    ] as const;

    // When / Then
    // This project's asset still lacks metadata, so the Asset tab is disabled;
    // enabled tabs are project, media, selection.
    expect(getNextEditorDockTabId({ currentTabId: 'project', key: 'ArrowRight', tabs })).toBe('media');
    expect(getNextEditorDockTabId({ currentTabId: 'media', key: 'ArrowRight', tabs })).toBe('selection');
    expect(getNextEditorDockTabId({ currentTabId: 'selection', key: 'ArrowRight', tabs })).toBe('project');
    expect(getNextEditorDockTabId({ currentTabId: 'media', key: 'Home', tabs })).toBe('project');
    expect(getNextEditorDockTabId({ currentTabId: 'media', key: 'End', tabs })).toBe('selection');
    expect(getNextEditorDockTabId({ currentTabId: 'selection', key: 'ArrowLeft', tabs })).toBe('media');
    expect(getNextEditorDockTabId({ currentTabId: 'inspector', key: 'ArrowRight', tabs })).toBe('selection');
  });

  it('filters out assets whose browser metadata is still pending', () => {
    // Given
    const project = makeProject();

    // When
    const readyAssets = filterPendingAssetsForDock(project.assets);

    // Then
    expect(readyAssets.map((asset) => asset.id)).toEqual(['asset-ready']);
    expect(readyAssets[0]?.metadata).toEqual({ durationMs: 4_000, width: 1_920, height: 1_080 });
  });

  it('does not send imported still images through the audio and video metadata probe', () => {
    const image = makeAsset({
      id: 'asset-image',
      displayName: 'character.png',
      kind: 'image',
      metadata: null,
      mimeType: 'image/png',
      projectRelativePath: 'assets/asset-image/original.png'
    });
    const pendingVideo = makeAsset({ id: 'asset-video', metadata: null });

    expect(assetsNeedingMetadata([image, pendingVideo]).map((asset) => asset.id)).toEqual(['asset-video']);
    expect(filterPendingAssetsForDock([image, pendingVideo]).map((asset) => asset.id)).toEqual(['asset-image']);
  });

  it('defaults the left dock to project before a project is loaded', () => {
    // Given / When / Then
    expect(getDefaultEditorLeftDockTabId({ hasProject: false, selectedAssetId: '' })).toBe('project');
  });

  it('defaults the left dock to media after a project is loaded', () => {
    // Given / When / Then
    expect(getDefaultEditorLeftDockTabId({ hasProject: true, selectedAssetId: '' })).toBe('media');
    expect(getDefaultEditorLeftDockTabId({ hasProject: true, selectedAssetId: 'asset-ready' })).toBe('media');
  });
});
