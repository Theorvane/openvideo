import { clipDurationMs, clipTimelineEndMs, placeClip, timelineDurationMs } from '../../../shared/timelineLogic';
import { STILL_DEFAULT_HOLD_MS, stillClipSource, trackKindForAsset } from '../../../shared/timelineStills';
import type { MediaAsset, MediaKind, TimelineClip, TimelineDocument, TimelineTrack } from '../../../shared/timelineTypes';

export type ClipBlock = {
  readonly assetName: string;
  readonly clip: TimelineClip;
  readonly kind: MediaKind;
  readonly leftPercent: number;
  readonly trackId: string;
  readonly widthPercent: number;
};

export type TimelineView = {
  readonly durationMs: number;
  readonly blocksByTrackId: Readonly<Record<string, readonly ClipBlock[]>>;
};

export type TimelineCoordinateInput = {
  readonly clientX: number;
  readonly laneLeft: number;
  readonly laneWidth: number;
  readonly durationMs: number;
  readonly snapMs?: number;
};

export type ClipSelection = {
  readonly asset: MediaAsset | null;
  readonly clip: TimelineClip;
  readonly track: TimelineTrack;
};

export type PlaybackClip = ClipSelection & {
  readonly sourceTimeMs: number;
};

export type PlacedTimelineAsset = {
  readonly timeline: TimelineDocument;
  readonly clip: TimelineClip;
  readonly playheadMs: number;
};

type ShortcutTarget = {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mediaAssetReady(asset: MediaAsset): boolean {
  return asset.kind === 'image' || (asset.metadata !== null && asset.metadata.durationMs > 0);
}

export function findFirstCompatibleTrack(timeline: TimelineDocument, kind: MediaKind): TimelineTrack | null {
  const trackKind = trackKindForAsset(kind);
  return timeline.tracks.find((track) => track.kind === trackKind) ?? null;
}

export function insertionStartForTrack(track: TimelineTrack): number {
  return track.clips.reduce((latestEndMs, clip) => Math.max(latestEndMs, clipTimelineEndMs(clip)), 0);
}

export function buildClipFromAsset(asset: MediaAsset, id: string, timelineStartMs: number): TimelineClip | null {
  if (asset.kind === 'image') {
    return {
      id,
      assetId: asset.id,
      timelineStartMs,
      ...stillClipSource(STILL_DEFAULT_HOLD_MS)
    };
  }
  const metadata = asset.metadata;
  if (metadata === null || metadata.durationMs <= 0) {
    return null;
  }
  return {
    id,
    assetId: asset.id,
    timelineStartMs,
    sourceStartMs: 0,
    sourceEndMs: metadata.durationMs,
    sourceDurationMs: metadata.durationMs
  };
}

export function placeReadyAssetOnTimeline(
  timeline: TimelineDocument,
  asset: MediaAsset,
  targetTrackId: string,
  clipId: string,
  timelineStartMs: number
): PlacedTimelineAsset | null {
  const targetTrack = timeline.tracks.find((track) => track.id === targetTrackId);
  if (targetTrack === undefined || targetTrack.kind !== trackKindForAsset(asset.kind)) {
    return null;
  }

  const clip = buildClipFromAsset(asset, clipId, timelineStartMs);
  if (clip === null) {
    return null;
  }
  const placedTimeline = placeClip(timeline, { trackId: targetTrack.id, clip });
  return placedTimeline === null ? null : { timeline: placedTimeline, clip, playheadMs: clip.timelineStartMs };
}

export function buildTimelineView(timeline: TimelineDocument, assets: readonly MediaAsset[]): TimelineView {
  const assetNamesById = new Map(assets.map((asset) => [asset.id, asset.displayName]));
  const durationMs = Math.max(timelineDurationMs(timeline), 1_000);
  const blocksByTrackId = Object.fromEntries(
    timeline.tracks.map((track) => [
      track.id,
      track.clips.map((clip) => ({
        assetName: assetNamesById.get(clip.assetId) ?? 'Missing asset',
        clip,
        kind: track.kind,
        leftPercent: (clip.timelineStartMs / durationMs) * 100,
        trackId: track.id,
        widthPercent: (clipDurationMs(clip) / durationMs) * 100
      }))
    ])
  );
  return { durationMs, blocksByTrackId };
}

export function clientXToTimelineMs(input: TimelineCoordinateInput): number {
  if (input.laneWidth <= 0 || input.durationMs <= 0) return 0;
  const rawMs = clamp((input.clientX - input.laneLeft) / input.laneWidth, 0, 1) * input.durationMs;
  const snapMs = input.snapMs ?? 1;
  return clamp(Math.round(rawMs / snapMs) * snapMs, 0, input.durationMs);
}

export function clampPlayheadMs(timeline: TimelineDocument, playheadMs: number): number {
  return clamp(playheadMs, 0, Math.max(timelineDurationMs(timeline), 0));
}

export function findPlaybackClipAt(timeline: TimelineDocument, assets: readonly MediaAsset[], playheadMs: number): PlaybackClip | null {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const playbackKindPriority = ['video', 'audio'] as const;
  for (const kind of playbackKindPriority) {
    for (const track of timeline.tracks) {
      if (track.kind !== kind) continue;
      const clip = track.clips.find((candidate) => playheadMs >= candidate.timelineStartMs && playheadMs < clipTimelineEndMs(candidate));
      if (clip !== undefined) {
        return { asset: assetById.get(clip.assetId) ?? null, clip, track, sourceTimeMs: clip.sourceStartMs + playheadMs - clip.timelineStartMs };
      }
    }
  }
  return null;
}

export function findClipSelection(timeline: TimelineDocument, assets: readonly MediaAsset[], clipId: string): ClipSelection | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) {
      return { asset: assets.find((asset) => asset.id === clip.assetId) ?? null, clip, track };
    }
  }
  return null;
}

export function nextTrackName(timeline: TimelineDocument, kind: MediaKind): string {
  const nextIndex = timeline.tracks.filter((track) => track.kind === kind).length + 1;
  return `${kind === 'video' ? 'Video' : 'Audio'} ${nextIndex}`;
}

export function isTextEditingShortcutTarget(target: ShortcutTarget | null): boolean {
  if (target === null) return false;
  const tagName = target.tagName?.toUpperCase();
  return target.isContentEditable === true || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}
