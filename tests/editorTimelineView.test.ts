import { describe, expect, it } from 'vitest';

import {
  buildClipFromAsset,
  buildTimelineView,
  clampPlayheadMs,
  clientXToTimelineMs,
  findClipSelection,
  findFirstCompatibleTrack,
  findPlaybackClipAt,
  insertionStartForTrack,
  isTextEditingShortcutTarget,
  mediaAssetReady,
  placeReadyAssetOnTimeline,
  nextTrackName
} from '../src/renderer/src/editor/editorTimelineView';
import { createTimelineHistory, pushTimelineHistory, redoTimelineHistory, undoTimelineHistory } from '../src/renderer/src/editor/editorTimelineHistory';
import { INITIAL_AUDIO_TRACK_ID, INITIAL_VIDEO_TRACK_ID, createInitialTimeline, placeClip } from '../src/shared/timelineLogic';
import { STILL_DEFAULT_HOLD_MS } from '../src/shared/timelineStills';
import { DEFAULT_CLIP_EFFECTS, type MediaAsset, type TimelineClip, type TimelineDocument } from '../src/shared/timelineTypes';

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    displayName: 'take.webm',
    projectRelativePath: 'assets/asset-1/original.webm',
    kind: 'video',
    mimeType: 'video/webm',
    byteLength: 100,
    metadata: { durationMs: 4_000, width: 1920, height: 1080 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    timelineStartMs: 1_000,
    sourceStartMs: 0,
    sourceEndMs: 4_000,
    sourceDurationMs: 4_000,
    ...overrides
  };
}

function requireTimeline(timeline: TimelineDocument | null): TimelineDocument {
  if (timeline === null) {
    throw new Error('Expected test timeline edit to succeed.');
  }
  return timeline;
}

describe('editor timeline view helpers', () => {
  it('reports whether imported assets have browser metadata', () => {
    // Given
    const readyAsset = makeAsset();
    const pendingAsset = makeAsset({ metadata: null });

    // When / Then
    expect(mediaAssetReady(readyAsset)).toBe(true);
    expect(mediaAssetReady(pendingAsset)).toBe(false);
    expect(buildClipFromAsset(pendingAsset, 'clip-a', 0)).toBeNull();
    expect(buildClipFromAsset(readyAsset, 'clip-a', 200)).toEqual({
      id: 'clip-a',
      assetId: 'asset-1',
      timelineStartMs: 200,
      sourceStartMs: 0,
      sourceEndMs: 4_000,
      sourceDurationMs: 4_000
    });
  });

  it('treats an imported image as a ready four-second still on the video track', () => {
    const image = makeAsset({
      id: 'asset-image',
      displayName: 'character.png',
      kind: 'image',
      metadata: null,
      mimeType: 'image/png',
      projectRelativePath: 'assets/asset-image/original.png'
    });
    const timeline = createInitialTimeline();

    expect(mediaAssetReady(image)).toBe(true);
    expect(findFirstCompatibleTrack(timeline, 'image')?.id).toBe(INITIAL_VIDEO_TRACK_ID);
    expect(buildClipFromAsset(image, 'clip-image', 250)).toEqual({
      id: 'clip-image',
      assetId: 'asset-image',
      timelineStartMs: 250,
      sourceStartMs: 0,
      sourceEndMs: STILL_DEFAULT_HOLD_MS,
      sourceDurationMs: STILL_DEFAULT_HOLD_MS
    });
    expect(placeReadyAssetOnTimeline(timeline, image, INITIAL_VIDEO_TRACK_ID, 'clip-image', 0)).not.toBeNull();
    expect(placeReadyAssetOnTimeline(timeline, image, INITIAL_AUDIO_TRACK_ID, 'clip-image', 0)).toBeNull();
  });

  it('finds compatible tracks and the next insertion point', () => {
    // Given
    const timeline = requireTimeline(placeClip(createInitialTimeline(), { trackId: INITIAL_VIDEO_TRACK_ID, clip: makeClip() }));
    const videoTrack = findFirstCompatibleTrack(timeline, 'video');

    // When / Then
    expect(videoTrack?.id).toBe(INITIAL_VIDEO_TRACK_ID);
    expect(findFirstCompatibleTrack(timeline, 'audio')?.id).toBe(INITIAL_AUDIO_TRACK_ID);
    expect(videoTrack === null ? 0 : insertionStartForTrack(videoTrack)).toBe(5_000);
    expect(nextTrackName(timeline, 'video')).toBe('Video 2');
  });

  it('builds percentage clip blocks and selected clip details', () => {
    // Given
    const asset = makeAsset();
    const timeline = requireTimeline(placeClip(createInitialTimeline(), { trackId: INITIAL_VIDEO_TRACK_ID, clip: makeClip() }));

    // When
    const view = buildTimelineView(timeline, [asset]);
    const selection = findClipSelection(timeline, [asset], 'clip-1');

    // Then
    expect(view.durationMs).toBe(5_000);
    expect(view.blocksByTrackId[INITIAL_VIDEO_TRACK_ID]).toEqual([
      {
        assetName: 'take.webm',
        clip: { ...makeClip(), effects: DEFAULT_CLIP_EFFECTS, keyframes: [] },
        kind: 'video',
        leftPercent: 20,
        trackId: INITIAL_VIDEO_TRACK_ID,
        widthPercent: 80
      }
    ]);
    expect(selection?.asset?.id).toBe('asset-1');
    expect(selection?.track.id).toBe(INITIAL_VIDEO_TRACK_ID);
    expect(findClipSelection(timeline, [asset], 'missing')).toBeNull();
  });

  it('maps lane coordinates to snapped bounded timeline positions', () => {
    expect(clientXToTimelineMs({ clientX: 150, laneLeft: 100, laneWidth: 200, durationMs: 4_000, snapMs: 250 })).toBe(1_000);
    expect(clientXToTimelineMs({ clientX: 40, laneLeft: 100, laneWidth: 200, durationMs: 4_000, snapMs: 250 })).toBe(0);
    expect(clientXToTimelineMs({ clientX: 420, laneLeft: 100, laneWidth: 200, durationMs: 4_000, snapMs: 250 })).toBe(4_000);
  });

  it('clamps playhead time and resolves the active video source offset', () => {
    const videoAsset = makeAsset();
    const audioAsset = makeAsset({ id: 'asset-2', kind: 'audio', displayName: 'voice.wav', metadata: { durationMs: 5_000 } });
    const video = requireTimeline(placeClip(createInitialTimeline(), {
      trackId: INITIAL_VIDEO_TRACK_ID,
      clip: makeClip({ timelineStartMs: 1_000, sourceStartMs: 500, sourceEndMs: 2_500 })
    }));
    const timeline = requireTimeline(placeClip(video, {
      trackId: INITIAL_AUDIO_TRACK_ID,
      clip: makeClip({ id: 'clip-audio', assetId: 'asset-2', timelineStartMs: 0, sourceEndMs: 5_000, sourceDurationMs: 5_000 })
    }));

    expect(clampPlayheadMs(timeline, -50)).toBe(0);
    expect(clampPlayheadMs(timeline, 9_000)).toBe(5_000);
    expect(findPlaybackClipAt(timeline, [videoAsset, audioAsset], 1_750)).toMatchObject({
      asset: { id: 'asset-1' },
      clip: { id: 'clip-1' },
      sourceTimeMs: 1_250
    });
    expect(findPlaybackClipAt(video, [videoAsset], 3_000)).toBeNull();
  });

  it('resolves an active audio-only clip with its precise source offset', () => {
    const audioAsset = makeAsset({
      id: 'asset-audio',
      kind: 'audio',
      displayName: 'voice.wav',
      metadata: { durationMs: 5_000 }
    });
    const timeline = requireTimeline(placeClip(createInitialTimeline(), {
      trackId: INITIAL_AUDIO_TRACK_ID,
      clip: makeClip({
        id: 'clip-audio',
        assetId: 'asset-audio',
        timelineStartMs: 2_000,
        sourceStartMs: 750,
        sourceEndMs: 4_750,
        sourceDurationMs: 5_000
      })
    }));

    expect(findPlaybackClipAt(timeline, [audioAsset], 3_250)).toMatchObject({
      asset: { id: 'asset-audio' },
      clip: { id: 'clip-audio' },
      track: { id: INITIAL_AUDIO_TRACK_ID },
      sourceTimeMs: 2_000
    });
  });

  it('selects video over overlapping audio regardless of track order', () => {
    const videoAsset = makeAsset();
    const audioAsset = makeAsset({
      id: 'asset-audio',
      kind: 'audio',
      displayName: 'voice.wav',
      metadata: { durationMs: 5_000 }
    });
    const withVideo = requireTimeline(placeClip(createInitialTimeline(), {
      trackId: INITIAL_VIDEO_TRACK_ID,
      clip: makeClip({ timelineStartMs: 1_000, sourceStartMs: 500, sourceEndMs: 2_500 })
    }));
    const withOverlap = requireTimeline(placeClip(withVideo, {
      trackId: INITIAL_AUDIO_TRACK_ID,
      clip: makeClip({
        id: 'clip-audio',
        assetId: 'asset-audio',
        timelineStartMs: 0,
        sourceEndMs: 5_000,
        sourceDurationMs: 5_000
      })
    }));
    const audioFirstTimeline: TimelineDocument = {
      ...withOverlap,
      tracks: [...withOverlap.tracks].reverse()
    };

    expect(findPlaybackClipAt(audioFirstTimeline, [videoAsset, audioAsset], 1_750)).toMatchObject({
      asset: { id: 'asset-1' },
      clip: { id: 'clip-1' },
      track: { id: INITIAL_VIDEO_TRACK_ID },
      sourceTimeMs: 1_250
    });
  });

  it('places a ready asset and exposes the clip start as the safe preview seek target', () => {
    // Given
    const videoAsset = makeAsset({ id: 'asset-2', displayName: 'scene.webm' });
    const occupiedTimeline = requireTimeline(placeClip(createInitialTimeline(), {
      trackId: INITIAL_VIDEO_TRACK_ID,
      clip: makeClip({ id: 'clip-occupied', timelineStartMs: 0, sourceEndMs: 1_000, sourceDurationMs: 1_000 })
    }));

    // When
    const placed = placeReadyAssetOnTimeline(occupiedTimeline, videoAsset, INITIAL_VIDEO_TRACK_ID, 'clip-ready-video', 1_500);

    // Then
    expect(placed).toMatchObject({
      clip: {
        assetId: 'asset-2',
        timelineStartMs: 1_500
      },
      playheadMs: 1_500
    });
    expect(placeReadyAssetOnTimeline(occupiedTimeline, videoAsset, INITIAL_AUDIO_TRACK_ID, 'clip-ready-audio', 1_500)).toBeNull();
    expect(placed === null ? null : findPlaybackClipAt(placed.timeline, [videoAsset], placed.playheadMs)).toMatchObject({
      clip: {
        assetId: 'asset-2',
        timelineStartMs: 1_500
      }
    });
    expect(placeReadyAssetOnTimeline(placed === null ? occupiedTimeline : placed.timeline, videoAsset, INITIAL_VIDEO_TRACK_ID, 'clip-overlap', 1_500)).toBeNull();
  });

  it('keeps timeline undo and redo history bounded', () => {
    const initial = createInitialTimeline();
    const first = requireTimeline(placeClip(initial, { trackId: INITIAL_VIDEO_TRACK_ID, clip: makeClip({ id: 'clip-a' }) }));
    const second = requireTimeline(placeClip(first, { trackId: INITIAL_VIDEO_TRACK_ID, clip: makeClip({ id: 'clip-b', timelineStartMs: 5_000 }) }));
    const third = requireTimeline(placeClip(second, { trackId: INITIAL_AUDIO_TRACK_ID, clip: makeClip({ id: 'clip-c' }) }));

    const history = pushTimelineHistory(pushTimelineHistory(pushTimelineHistory(createTimelineHistory(initial, 2), first), second), third);
    expect(history.past).toHaveLength(2);
    expect(undoTimelineHistory(history)?.present).toBe(second);
    const undone = undoTimelineHistory(history);
    expect(undone === null ? null : redoTimelineHistory(undone)?.present).toBe(third);
  });

  it('guards timeline shortcuts while focus is inside editable text controls', () => {
    expect(isTextEditingShortcutTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEditingShortcutTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEditingShortcutTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEditingShortcutTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEditingShortcutTarget(null)).toBe(false);
  });
});
