import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addTrack,
  addTrackBeside,
  removeTrack,
  renameTrack,
  deleteClip,
  moveClip,
  placeClip,
  splitClip,
  trimClipLeft,
  timelineDurationMs,
  trimClipRight,
  updateClipEffects
} from '../../../shared/timelineLogic';
import { isValidClipEffects } from '../../../shared/timelineEffects';
import {
  cutNearest,
  removeTransitionAtCut,
  setTransitionAtCut,
  transitionForCut,
  type TimelineCut
} from '../../../shared/timelineTransitionLogic';
import { DEFAULT_CLIP_EFFECTS } from '../../../shared/timelineTypes';
import type {
  ClipEffects,
  LocalProjectSnapshot,
  LocalProjectSummary,
  MediaAsset,
  MediaKind,
  TimelineDocument,
  TransitionType
} from '../../../shared/timelineTypes';
import { clipDurationMs, clipTimelineEndMs } from '../../../shared/timelineClipGeometry';
import { addTitle, removeTitle, titleAt, updateTitle } from '../../../shared/timelineTitleLogic';
import { applyTitleAppearanceToAutomaticCaptions } from '../../../shared/captionStyle';
import { applySubtitleCues } from '../../../shared/subtitleWorkflow';
import type { NarrationPlan } from '../../../shared/narrationPlan';
import { applyTranscriptionCues, type TranscriptionDraft } from '../../../shared/transcription';
import { errorMessage, type StatusMessage } from '../appTypes';
import { createTimelineHistory, pushTimelineHistory, redoTimelineHistory, undoTimelineHistory, type TimelineHistory } from './editorTimelineHistory';
import { clampPlayheadMs, findClipSelection, findFirstCompatibleTrack, insertionStartForTrack, mediaAssetReady, nextTrackName, placeReadyAssetOnTimeline } from './editorTimelineView';
import { metadataProbeFailureMessage } from './mediaLoadFailures';
import { useProjectAssetImports } from './useProjectAssetImports';
import { useTimelinePlayback } from './useTimelinePlayback';
import type { AiProjectDocument } from '../../../shared/aiProjectDomain';
import { detachVideoAudioOnTimeline } from '../../../shared/detachVideoAudio';
import { assembleApprovedProductionCut, buildApprovedProductionAssemblyPlan } from '../../../shared/productionWorkflow';

type TimelineUpdate = (timeline: TimelineDocument) => TimelineDocument | null;

function createOpaqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function useTimelineEditor() {
  const [projects, setProjects] = useState<readonly LocalProjectSummary[]>([]);
  const [project, setProject] = useState<LocalProjectSnapshot | null>(null);
  const [newProjectName, setNewProjectName] = useState('Untitled cutdown');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  // Multi-selection for bulk actions (select all, delete). The single
  // selectedClipId stays the primary selection that drives the Inspector.
  const [selectedClipIds, setSelectedClipIds] = useState<readonly string[]>([]);
  const [timelineHistory, setTimelineHistory] = useState<TimelineHistory | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [hasUnsavedTimeline, setHasUnsavedTimeline] = useState(false);
  const [metadataProbeFailuresByAssetId, setMetadataProbeFailuresByAssetId] = useState<Readonly<Record<string, string>>>({});
  const [metadataProbeRetryRevisionsByAssetId, setMetadataProbeRetryRevisionsByAssetId] = useState<Readonly<Record<string, number>>>({});
  const [statusMessage, setStatusMessage] = useState<StatusMessage>({ tone: 'neutral', text: 'Create or open a project to start editing locally.' });
  const projectRef = useRef<LocalProjectSnapshot | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const selectedAsset = useMemo(
    () => project?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [project, selectedAssetId]
  );
  const selectedClip = useMemo(
    () => project === null || selectedClipId.length === 0 ? null : findClipSelection(project.timeline, project.assets, selectedClipId),
    [project, selectedClipId]
  );
  const playback = useTimelinePlayback(project);

  const setLoadedProject = useCallback((snapshot: LocalProjectSnapshot | null) => {
    setProject(snapshot);
    setSelectedClipIds([]);
    setTimelineHistory(snapshot === null ? null : createTimelineHistory(snapshot.timeline));
    playback.resetPlayback();
  }, [playback]);

  const refreshProjects = useCallback(async () => {
    try {
      const response = await window.videoTool.listProjects();
      if (response.ok) {
        setProjects(response.value);
        return;
      }
      setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    } catch (error: unknown) {
      setStatusMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Projects could not be listed.' });
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    setMetadataProbeFailuresByAssetId({});
    setMetadataProbeRetryRevisionsByAssetId({});
  }, [project?.id]);

  const clearMetadataProbeFailure = useCallback((assetId: string) => {
    setMetadataProbeFailuresByAssetId((current) => {
      if (current[assetId] === undefined) return current;
      const next = { ...current };
      delete next[assetId];
      return next;
    });
  }, []);

  const reportMetadataProbeFailure = useCallback((assetId: string) => {
    setMetadataProbeFailuresByAssetId((current) => ({ ...current, [assetId]: metadataProbeFailureMessage() }));
  }, []);

  const retryAssetMetadataProbe = useCallback((assetId: string) => {
    clearMetadataProbeFailure(assetId);
    setMetadataProbeRetryRevisionsByAssetId((current) => ({ ...current, [assetId]: (current[assetId] ?? 0) + 1 }));
  }, [clearMetadataProbeFailure]);

  const invokeWhileBusy = useCallback(async <T,>(invoke: () => Promise<T>, failureMessage: string): Promise<T | null> => {
    setIsBusy(true);
    try {
      return await invoke();
    } catch (error: unknown) {
      setStatusMessage({ tone: 'danger', text: error instanceof Error ? error.message : failureMessage });
      return null;
    } finally {
      setIsBusy(false);
    }
  }, []);

  const openProject = useCallback(async (projectId: string): Promise<boolean> => {
    const response = await invokeWhileBusy(() => window.videoTool.openProject({ projectId }), 'The project could not be opened.');
    if (response === null) return false;
    if (response.ok) {
      setLoadedProject(response.value);
      setSelectedAssetId(response.value.assets[0]?.id ?? '');
      setSelectedClipId('');
      setHasUnsavedTimeline(false);
      setStatusMessage({ tone: 'neutral', text: '' });
      return true;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    return false;
  }, [invokeWhileBusy, setLoadedProject]);

  const createProject = useCallback(async (): Promise<boolean> => {
    const response = await invokeWhileBusy(() => window.videoTool.createProject({ name: newProjectName }), 'The project could not be created.');
    if (response === null) return false;
    if (response.ok) {
      if (response.value.cancelled) {
        return false;
      }
      const project = response.value.project;
      setLoadedProject(project);
      setSelectedAssetId('');
      setSelectedClipId('');
      setHasUnsavedTimeline(false);
      await refreshProjects();
      setStatusMessage({ tone: 'success', text: `Created ${project.name} in its own folder.` });
      return true;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    return false;
  }, [invokeWhileBusy, newProjectName, refreshProjects, setLoadedProject]);

  const openProjectFolder = useCallback(async (): Promise<boolean> => {
    const response = await invokeWhileBusy(() => window.videoTool.openProjectFolder(), 'The project folder could not be opened.');
    if (response === null) return false;
    if (response.ok) {
      if (response.value.cancelled) {
        return false;
      }
      const project = response.value.project;
      setLoadedProject(project);
      setSelectedAssetId(project.assets[0]?.id ?? '');
      setSelectedClipId('');
      setHasUnsavedTimeline(false);
      await refreshProjects();
      setStatusMessage(response.value.created
        ? { tone: 'success', text: `Created ${project.name} in the selected folder.` }
        : { tone: 'neutral', text: '' });
      return true;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    return false;
  }, [invokeWhileBusy, refreshProjects, setLoadedProject]);

  const deleteCurrentProject = useCallback(async () => {
    if (project === null) return;
    const response = await invokeWhileBusy(() => window.videoTool.deleteProject({ projectId: project.id }), 'The project could not be deleted.');
    if (response === null) return;
    if (response.ok) {
      setLoadedProject(null);
      setSelectedAssetId('');
      setSelectedClipId('');
      setHasUnsavedTimeline(false);
      await refreshProjects();
      setStatusMessage({ tone: 'warning', text: 'Project deleted locally.' });
      return;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
  }, [invokeWhileBusy, project, refreshProjects, setLoadedProject]);

  const { importAssets, importRecordingResult, importAiResult } = useProjectAssetImports({ project, setIsBusy, setProject, setSelectedAssetId, setStatusMessage });

  const replaceTimeline = useCallback((update: TimelineUpdate, successText: string, rejectionText?: string): TimelineDocument | null => {
    if (project === null) return null;
    const timeline = update(project.timeline);
    if (timeline === null) {
      // The generic message is right for clip edits, where the rule broken is
      // rarely one the user was thinking about. Track edits get to say why.
      setStatusMessage({
        tone: 'warning',
        text: rejectionText ?? 'Timeline edit was rejected because it would break track or clip rules.'
      });
      return null;
    }
    setProject({ ...project, timeline });
    setTimelineHistory((current) => current === null ? createTimelineHistory(timeline) : pushTimelineHistory(current, timeline));
    playback.clampToTimeline(timeline);
    setHasUnsavedTimeline(true);
    setStatusMessage({ tone: 'neutral', text: successText });
    return timeline;
  }, [playback, project]);

  /*
    Transitions.

    Addressed by the playhead, like a title and for a sharper reason: a
    transition lives *between* two clips, and there is nothing between two clips
    to select. Park the playhead near a cut and the controls apply to that cut.
  */
  const cutAtPlayhead = useMemo<TimelineCut | null>(
    () => (project === null ? null : cutNearest(project.timeline, playback.playheadMs)),
    [playback.playheadMs, project]
  );

  const transitionAtPlayhead = useMemo(
    () => (project === null || cutAtPlayhead === null ? null : transitionForCut(project.timeline, cutAtPlayhead)),
    [cutAtPlayhead, project]
  );

  const setTransitionAtPlayhead = useCallback(
    (type: TransitionType, durationMs?: number) => {
      if (cutAtPlayhead === null) return;
      replaceTimeline(
        (timeline) =>
          setTransitionAtCut(timeline, cutAtPlayhead, durationMs === undefined ? { type } : { type, durationMs }),
        'Set the transition.',
        'A transition has to fit inside both of the clips it joins.'
      );
    },
    [cutAtPlayhead, replaceTimeline]
  );

  const removeTransitionAtPlayhead = useCallback(() => {
    if (cutAtPlayhead === null) return;
    replaceTimeline((timeline) => removeTransitionAtCut(timeline, cutAtPlayhead), 'Removed the transition.');
  }, [cutAtPlayhead, replaceTimeline]);

  /*
    Titles.

    They are not clips, so they do not go through the placement rules — a title
    overlaps whatever it likes, which is the point of a caption. What they do
    share is the undo history and the "rejected, and here is why" path, because
    a rule that refuses silently is the thing this editor keeps being caught by.
  */
  const addTitleAtPlayhead = useCallback(() => {
    replaceTimeline(
      (timeline) => addTitle(timeline, { id: createOpaqueId('title'), atMs: playback.playheadMs }),
      'Added a title.'
    );
  }, [playback.playheadMs, replaceTimeline]);

  const editTitle = useCallback(
    (id: string, changes: Parameters<typeof updateTitle>[2]) => {
      replaceTimeline(
        (timeline) => updateTitle(timeline, id, changes),
        'Updated the title.',
        'That change would leave the title with nothing to draw.'
      );
    },
    [replaceTimeline]
  );

  const deleteTitle = useCallback(
    (id: string) => {
      replaceTimeline((timeline) => removeTitle(timeline, id), 'Removed the title.');
    },
    [replaceTimeline]
  );

  const applyTitleStyleToAutomaticCaptions = useCallback(
    (sourceTitleId: string) => {
      replaceTimeline(
        (timeline) => applyTitleAppearanceToAutomaticCaptions(timeline, sourceTitleId),
        'Applied the title appearance to every automatic caption.',
        'There are no automatic captions to style.'
      );
    },
    [replaceTimeline]
  );

  const applyNarrationSubtitles = useCallback((plan: NarrationPlan): boolean => {
    if (project === null) return false;
    try {
      return replaceTimeline(() => applySubtitleCues(project.timeline, plan), `Applied ${plan.cues.length} reviewed subtitle cue(s).`) !== null;
    } catch {
      return false;
    }
  }, [project, replaceTimeline]);

  const applyTranscriptionSubtitles = useCallback((draft: TranscriptionDraft): boolean => {
    if (project === null) return false;
    try {
      return replaceTimeline(() => applyTranscriptionCues(project.timeline, draft), `Applied ${draft.cues.length} reviewed transcript cue(s).`) !== null;
    } catch {
      return false;
    }
  }, [project, replaceTimeline]);

  /** The title under the playhead, which is the one an inspector should be showing. */
  const titleAtPlayhead = useMemo(
    () => (project === null ? null : titleAt(project.timeline, playback.playheadMs)),
    [playback.playheadMs, project]
  );

  const placeSelectedAsset = useCallback(() => {
    if (project === null || selectedAsset === null || !mediaAssetReady(selectedAsset)) return;
    const track = findFirstCompatibleTrack(project.timeline, selectedAsset.kind);
    if (track === null) return;
    const placement = placeReadyAssetOnTimeline(project.timeline, selectedAsset, track.id, createOpaqueId('clip'), insertionStartForTrack(track));
    if (placement === null) return;
    const timeline = replaceTimeline(() => placement.timeline, `Placed ${selectedAsset.displayName} on ${track.name}.`);
    if (timeline === null) return;
    playback.setPlayheadMs(placement.playheadMs, timeline);
    setSelectedClipId(placement.clip.id);
  }, [playback, project, replaceTimeline, selectedAsset]);

  const placeAssetOnTimeline = useCallback((assetId: string): boolean => {
    if (project === null) return false;
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined || !mediaAssetReady(asset)) return false;
    const track = findFirstCompatibleTrack(project.timeline, asset.kind);
    if (track === null) return false;
    const placement = placeReadyAssetOnTimeline(project.timeline, asset, track.id, createOpaqueId('clip'), insertionStartForTrack(track));
    if (placement === null) return false;
    const timeline = replaceTimeline(() => placement.timeline, `Placed approved candidate ${asset.displayName} on ${track.name}.`);
    if (timeline === null) return false;
    playback.setPlayheadMs(placement.playheadMs, timeline);
    setSelectedAssetId(asset.id);
    setSelectedClipId(placement.clip.id);
    return true;
  }, [playback, project, replaceTimeline]);

  const assembleApprovedWriterShots = useCallback((): boolean => {
    if (project === null) return false;
    const plan = buildApprovedProductionAssemblyPlan(project.ai, project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      durationMs: asset.metadata?.durationMs ?? null
    })));
    if (!plan.ok) {
      setStatusMessage({ tone: 'warning', text: plan.reason });
      return false;
    }
    const target = project.timeline.tracks.find((track) => track.kind === 'video');
    if (target === undefined) {
      setStatusMessage({ tone: 'warning', text: 'Add a video track before assembling the approved production cut.' });
      return false;
    }
    const assembled = assembleApprovedProductionCut({
      timeline: project.timeline,
      plan,
      targetTrackId: target.id,
      clipIdForShot: () => createOpaqueId('production-clip')
    });
    if (!assembled.ok) {
      setStatusMessage({ tone: 'warning', text: assembled.reason });
      return false;
    }
    const timeline = replaceTimeline(
      () => assembled.timeline,
      `Assembled ${plan.shots.length} approved Writer shot(s) in production order.`
    );
    if (timeline === null) return false;
    playback.setPlayheadMs(Math.max(0, timelineDurationMs(timeline) - plan.totalDurationMs), timeline);
    return true;
  }, [playback, project, replaceTimeline]);

  const placeAssetOnTrack = useCallback((assetId: string, trackId: string, timelineStartMs: number) => {
    if (project === null) return;
    const asset = project.assets.find((candidate) => candidate.id === assetId) ?? null;
    if (asset === null) return;
    const placement = placeReadyAssetOnTimeline(project.timeline, asset, trackId, createOpaqueId('clip'), timelineStartMs);
    if (placement === null) return;
    const timeline = replaceTimeline(() => placement.timeline, `Placed ${asset.displayName} on the timeline.`);
    if (timeline === null) return;
    playback.setPlayheadMs(placement.playheadMs, timeline);
    setSelectedAssetId(asset.id);
    setSelectedClipId(placement.clip.id);
  }, [playback, project, replaceTimeline]);

  const addTimelineTrack = useCallback((kind: MediaKind) => {
    replaceTimeline((timeline) => addTrack(timeline, { id: createOpaqueId(`${kind}-track`), kind, name: nextTrackName(timeline, kind) }), `Added a ${kind} track.`);
  }, [replaceTimeline]);

  const removeTimelineTrack = useCallback((trackId: string) => {
    replaceTimeline(
      (timeline) => removeTrack(timeline, trackId),
      'Removed the track.',
      // The model refuses to remove the last track of a kind; say why rather
      // than letting the click look like it did nothing.
      'A project needs at least one video and one audio track.'
    );
  }, [replaceTimeline]);

  const renameTimelineTrack = useCallback((trackId: string, name: string) => {
    replaceTimeline((timeline) => renameTrack(timeline, trackId, name), 'Renamed the track.', 'That track name is not valid.');
  }, [replaceTimeline]);

  /** Inserts a same-kind track above or below an existing one. */
  const insertTimelineTrack = useCallback((trackId: string, position: 'above' | 'below') => {
    replaceTimeline((timeline) => {
      const kind = timeline.tracks.find((track) => track.id === trackId)?.kind;
      if (kind === undefined) return null;
      return addTrackBeside(
        timeline,
        { trackId, position },
        { id: createOpaqueId(`${kind}-track`), kind, name: nextTrackName(timeline, kind) }
      );
    }, 'Added a track.', 'The track could not be added.');
  }, [replaceTimeline]);

  const selectClip = useCallback((clipId: string) => {
    setSelectedClipId(clipId);
    setSelectedClipIds(clipId.length === 0 ? [] : [clipId]);
  }, []);

  const selectAllClips = useCallback(() => {
    if (project === null) return;
    const clipIds = project.timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
    setSelectedClipIds(clipIds);
    // The Inspector needs one clip; keep the current one when it is still there.
    setSelectedClipId((current) => (clipIds.includes(current) ? current : clipIds[0] ?? ''));
    setStatusMessage({
      tone: 'neutral',
      text: clipIds.length === 0 ? 'No clips on the timeline to select.' : `Selected ${clipIds.length} clips.`
    });
  }, [project]);

  const clearSelection = useCallback(() => {
    selectClip('');
  }, [selectClip]);

  const stepPlayhead = useCallback((deltaMs: number) => {
    playback.setPlayheadMs(Math.max(0, playback.playheadMs + deltaMs), project?.timeline);
  }, [playback, project]);

  const goToTimelineStart = useCallback(() => {
    playback.setPlayheadMs(0, project?.timeline);
  }, [playback, project]);

  const goToTimelineEnd = useCallback(() => {
    if (project === null) return;
    playback.setPlayheadMs(timelineDurationMs(project.timeline), project.timeline);
  }, [playback, project]);

  const deleteSelectedClip = useCallback(() => {
    const clipIds = selectedClipIds.length > 0 ? selectedClipIds : selectedClip === null ? [] : [selectedClip.clip.id];
    if (clipIds.length === 0) return;
    replaceTimeline(
      (timeline) => clipIds.reduce<TimelineDocument | null>((next, clipId) => next === null ? null : deleteClip(next, clipId), timeline),
      clipIds.length === 1 ? 'Deleted selected clip.' : `Deleted ${clipIds.length} clips.`
    );
    setSelectedClipId('');
    setSelectedClipIds([]);
  }, [replaceTimeline, selectedClip, selectedClipIds]);

  const moveSelectedClip = useCallback((deltaMs: number) => {
    if (selectedClip === null) return;
    const startMs = Math.max(0, selectedClip.clip.timelineStartMs + deltaMs);
    replaceTimeline((timeline) => moveClip(timeline, { clipId: selectedClip.clip.id, targetTrackId: selectedClip.track.id, timelineStartMs: startMs }), 'Moved selected clip.');
  }, [replaceTimeline, selectedClip]);

  const moveClipToTrack = useCallback((clipId: string, trackId: string, timelineStartMs: number) => {
    replaceTimeline((timeline) => moveClip(timeline, { clipId, targetTrackId: trackId, timelineStartMs: Math.max(0, timelineStartMs) }), 'Moved selected clip.');
    setSelectedClipId(clipId);
  }, [replaceTimeline]);

  const trimSelectedClip = useCallback((edge: 'left' | 'right', deltaMs: number) => {
    if (selectedClip === null) return;
    replaceTimeline((timeline) => edge === 'left'
      ? trimClipLeft(timeline, { clipId: selectedClip.clip.id, timelineStartMs: selectedClip.clip.timelineStartMs + deltaMs })
      : trimClipRight(timeline, { clipId: selectedClip.clip.id, timelineEndMs: clipTimelineEndMs(selectedClip.clip) + deltaMs }), 'Trimmed selected clip.');
  }, [replaceTimeline, selectedClip]);

  const trimClipTo = useCallback((clipId: string, edge: 'left' | 'right', timelineMs: number) => {
    replaceTimeline((timeline) => edge === 'left'
      ? trimClipLeft(timeline, { clipId, timelineStartMs: timelineMs })
      : trimClipRight(timeline, { clipId, timelineEndMs: timelineMs }), 'Trimmed selected clip.');
    setSelectedClipId(clipId);
  }, [replaceTimeline]);

  const splitSelectedClip = useCallback(() => {
    if (selectedClip === null) return;
    const midpointMs = selectedClip.clip.timelineStartMs + Math.round(clipDurationMs(selectedClip.clip) / 2);
    replaceTimeline((timeline) => splitClip(timeline, { clipId: selectedClip.clip.id, atMs: midpointMs, rightClipId: createOpaqueId('clip') }), 'Split selected clip at its midpoint.');
  }, [replaceTimeline, selectedClip]);

  const splitAtPlayhead = useCallback(() => {
    if (selectedClip === null) return;
    replaceTimeline((timeline) => splitClip(timeline, { clipId: selectedClip.clip.id, atMs: playback.playheadMs, rightClipId: createOpaqueId('clip') }), 'Split selected clip at the playhead.');
  }, [playback.playheadMs, replaceTimeline, selectedClip]);

  const splitClipAt = useCallback((clipId: string, atMs: number) => {
    replaceTimeline((timeline) => splitClip(timeline, { clipId, atMs, rightClipId: createOpaqueId('clip') }), 'Split clip with the razor tool.');
  }, [replaceTimeline]);

  const duplicateSelectedClip = useCallback(() => {
    if (selectedClip === null) return;
    const source = selectedClip.clip;
    const duplicatedStartMs = clipTimelineEndMs(source);
    const timeline = replaceTimeline(
      (current) => placeClip(current, {
        trackId: selectedClip.track.id,
        clip: { ...source, id: createOpaqueId('clip'), timelineStartMs: duplicatedStartMs }
      }),
      'Duplicated the selected clip after itself.'
    );
    if (timeline === null) return;
  }, [replaceTimeline, selectedClip]);

  const updateSelectedClipEffects = useCallback((effects: Partial<ClipEffects>) => {
    if (selectedClip === null) return;
    /*
      Two ways this can be refused, and the generic message fits only one.

      Until speed, an effect could only be out of range. Speed changes how much
      room the clip takes, so slowing one down can also be refused for running
      into its neighbour — and the shared rule returns `null` either way. If the
      values themselves are fine, the refusal was about where the clip lands.
    */
    const next: ClipEffects = { ...DEFAULT_CLIP_EFFECTS, ...selectedClip.clip.effects, ...effects };
    replaceTimeline(
      (timeline) => updateClipEffects(timeline, { clipId: selectedClip.clip.id, effects }),
      'Updated selected clip effects.',
      isValidClipEffects(next)
        ? 'A slower clip needs more room — move the next clip along first.'
        : undefined
    );
  }, [replaceTimeline, selectedClip]);

  const detachSelectedClipAudio = useCallback(async (): Promise<void> => {
    const sourceProject = projectRef.current;
    const sourceSelection = selectedClip;
    if (sourceProject === null || sourceSelection?.asset?.kind !== 'video') return;

    setStatusMessage({ tone: 'neutral', text: 'Extracting the selected video audio with FFmpeg…' });
    const response = await invokeWhileBusy(() => window.videoTool.detachVideoAudio({
      projectId: sourceProject.id,
      assetId: sourceSelection.asset!.id
    }), 'The video audio extraction request failed.');
    if (response === null) return;
    if (!response.ok) {
      setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
      return;
    }

    const current = projectRef.current;
    if (current === null || current.id !== sourceProject.id) {
      setStatusMessage({
        tone: 'warning',
        text: 'Audio was extracted into the project library, but the project changed before it could be placed.'
      });
      return;
    }
    const transaction = detachVideoAudioOnTimeline(current.timeline, {
      sourceClipId: sourceSelection.clip.id,
      audioAsset: response.value.asset,
      audioClipId: createOpaqueId('detached-audio'),
      fallbackAudioTrackId: createOpaqueId('audio-track'),
      fallbackAudioTrackName: nextTrackName(current.timeline, 'audio')
    });
    const assets = current.assets.some((asset) => asset.id === response.value.asset.id)
      ? current.assets
      : [...current.assets, response.value.asset];
    if (transaction === null) {
      setProject({ ...current, assets });
      setSelectedAssetId(response.value.asset.id);
      setStatusMessage({
        tone: 'warning',
        text: 'Audio was extracted into the project library, but its synchronized timeline placement was rejected.'
      });
      return;
    }

    const nextProject = { ...current, assets, timeline: transaction.timeline };
    projectRef.current = nextProject;
    setProject(nextProject);
    setTimelineHistory((history) => history === null
      ? createTimelineHistory(transaction.timeline)
      : pushTimelineHistory(history, transaction.timeline));
    playback.clampToTimeline(transaction.timeline);
    setSelectedAssetId(response.value.asset.id);
    setSelectedClipId(transaction.audioClip.id);
    setSelectedClipIds([transaction.audioClip.id]);
    setHasUnsavedTimeline(true);
    setStatusMessage({
      tone: 'success',
      text: `Detached audio to ${transaction.audioTrackId}. The source video clip is muted to prevent duplicate sound.`
    });
  }, [invokeWhileBusy, playback, selectedClip]);

  const undoTimeline = useCallback(() => {
    if (timelineHistory === null) return;
    const next = undoTimelineHistory(timelineHistory);
    if (next === null) return;
    setTimelineHistory(next);
    setProject((current) => current === null ? current : { ...current, timeline: next.present });
    playback.clampToTimeline(next.present);
    setHasUnsavedTimeline(true);
    setStatusMessage({ tone: 'neutral', text: 'Undid timeline edit.' });
  }, [playback, timelineHistory]);

  const redoTimeline = useCallback(() => {
    if (timelineHistory === null) return;
    const next = redoTimelineHistory(timelineHistory);
    if (next === null) return;
    setTimelineHistory(next);
    setProject((current) => current === null ? current : { ...current, timeline: next.present });
    playback.clampToTimeline(next.present);
    setHasUnsavedTimeline(true);
    setStatusMessage({ tone: 'neutral', text: 'Redid timeline edit.' });
  }, [playback, timelineHistory]);

  const updateAssetMetadata = useCallback(async (assetId: string, metadata: { readonly durationMs: number; readonly width?: number; readonly height?: number }): Promise<boolean> => {
    if (project === null) return false;
    const response = await window.videoTool.updateAssetMetadata({ projectId: project.id, assetId, ...metadata });
    if (response.ok) {
      setProject((current) => current === null ? current : { ...current, assets: current.assets.map((asset) => asset.id === response.value.id ? response.value : asset) });
      clearMetadataProbeFailure(assetId);
      return true;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    return false;
  }, [clearMetadataProbeFailure, project]);

  // The Edit Agent writes the project on disk from the main process, so an open
  // editor must reload — otherwise the change is invisible and the next local
  // save silently overwrites it. The edit always lands: it was asked for. Local
  // unsaved work is not discarded but pushed onto the undo stack, because
  // refusing to load left the agent's result invisible after any local edit.
  useEffect(() => {
    const openProjectId = project?.id;
    if (openProjectId === undefined) return;
    return window.videoTool.onProjectTimelineChanged((changedProjectId) => {
      if (changedProjectId !== openProjectId) return;
      void (async () => {
        const response = await window.videoTool.openProject({ projectId: openProjectId });
        if (!response.ok) {
          setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
          return;
        }
        const snapshot = response.value;
        if (!hasUnsavedTimeline) {
          setLoadedProject(snapshot);
          setStatusMessage({ tone: 'success', text: 'Timeline updated by the Edit Agent.' });
          return;
        }
        setProject(snapshot);
        setTimelineHistory((current) => current === null
          ? createTimelineHistory(snapshot.timeline)
          : pushTimelineHistory(current, snapshot.timeline));
        playback.clampToTimeline(snapshot.timeline);
        // In memory now matches disk; undo restores the local work.
        setHasUnsavedTimeline(false);
        setStatusMessage({ tone: 'warning', text: 'Loaded the Edit Agent timeline. Your unsaved edits are one undo away.' });
      })();
    });
  }, [hasUnsavedTimeline, playback, project?.id, setLoadedProject]);

  const renameProject = useCallback(async (name: string): Promise<boolean> => {
    if (project === null) return false;
    const response = await window.videoTool.renameProject({ projectId: project.id, name });
    if (!response.ok) {
      setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
      return false;
    }
    // Only the label changes; the timeline and history in memory stay as they are.
    setProject((current) => current === null ? current : { ...current, name: response.value.name, updatedAt: response.value.updatedAt });
    await refreshProjects();
    setStatusMessage({ tone: 'success', text: `Renamed to ${response.value.name}.` });
    return true;
  }, [project, refreshProjects]);

  const saveTimeline = useCallback(async (): Promise<boolean> => {
    if (project === null) return false;
    const response = await invokeWhileBusy(
      () => window.videoTool.saveTimeline({ projectId: project.id, timeline: project.timeline }),
      'The timeline could not be saved.'
    );
    if (response === null) return false;
    if (response.ok) {
      setLoadedProject(response.value);
      setHasUnsavedTimeline(false);
      setStatusMessage({ tone: 'success', text: 'Timeline saved locally.' });
      return true;
    }
    setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
    return false;
  }, [invokeWhileBusy, project, setLoadedProject]);

  const saveAiProjectDocument = useCallback(async (ai: AiProjectDocument): Promise<boolean> => {
    if (project === null) return false;
    const response = await window.videoTool.saveAiProjectDocument({ projectId: project.id, ai });
    if (!response.ok) {
      setStatusMessage({ tone: 'danger', text: errorMessage(response.error) });
      return false;
    }
    // Saving a script must not replace unsaved in-memory timeline edits with
    // the older timeline snapshot that happened to be on disk.
    setProject((current) => current === null || current.id !== response.value.id ? current : {
      ...current,
      // Other main-process AI actions (for example, continuity-frame
      // extraction) may have added a project asset immediately before this AI
      // document save. Keep unsaved timeline edits, but accept the authoritative
      // asset library from the same project snapshot.
      assets: response.value.assets,
      ai: response.value.ai,
      updatedAt: response.value.updatedAt
    });
    await refreshProjects();
    setStatusMessage({ tone: 'success', text: 'AI project data saved locally.' });
    return true;
  }, [project, refreshProjects]);

  return {
    addTimelineTrack, removeTimelineTrack, renameTimelineTrack, insertTimelineTrack, createProject, deleteCurrentProject, deleteSelectedClip, duplicateSelectedClip, hasUnsavedTimeline, importAssets,
    importRecordingResult, importAiResult, isBusy, metadataProbeFailuresByAssetId, metadataProbeRetryRevisionsByAssetId, moveSelectedClip, newProjectName,
    cutAtPlayhead, transitionAtPlayhead, setTransitionAtPlayhead, removeTransitionAtPlayhead,
    addTitleAtPlayhead, editTitle, deleteTitle, applyTitleStyleToAutomaticCaptions, titleAtPlayhead, applyNarrationSubtitles, applyTranscriptionSubtitles,
    openProject, openProjectFolder, renameProject, placeSelectedAsset, placeAssetOnTimeline, assembleApprovedWriterShots, project, projects, refreshProjects, reportMetadataProbeFailure, retryAssetMetadataProbe, saveTimeline, saveAiProjectDocument,
    clearSelection, goToTimelineEnd, goToTimelineStart, selectAllClips, selectedAsset, selectedAssetId, selectedClip, selectedClipId, selectedClipIds,
    setNewProjectName, setSelectedAssetId, setSelectedClipId: selectClip,
    splitSelectedClip, statusMessage, trimSelectedClip, updateAssetMetadata, updateSelectedClipEffects, detachSelectedClipAudio,
    activePlaybackClip: playback.activePlaybackClip, canRedoTimeline: (timelineHistory?.future.length ?? 0) > 0,
    canUndoTimeline: (timelineHistory?.past.length ?? 0) > 0, isPlaying: playback.isPlaying, moveClipToTrack,
    placeAssetOnTrack, playheadMs: playback.playheadMs, redoTimeline, setIsPlaying: playback.setIsPlaying,
    setPlayheadMs: playback.setPlayheadMs, splitAtPlayhead, stepPlayhead, splitClipAt, trimClipTo, undoTimeline
  };
}

export type TimelineEditorController = ReturnType<typeof useTimelineEditor>;
