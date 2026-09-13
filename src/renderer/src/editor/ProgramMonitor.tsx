import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';

import type { TimelineEditorController } from './useTimelineEditor';
import { effectCssFilter, effectCssTransform } from './clipEffectControls';
import { buildTimelineView } from './editorTimelineView';
import {
  programMonitorPreviewLoadState,
  type ProgramMonitorPreviewLoadState
} from './mediaLoadFailures';
import {
  syncTimelineMediaPlayback,
  syncTimelineMediaTime,
  syncTimelineMediaVolume,
  type TimelineMediaEffectsElement
} from './programMonitorMediaSync';
import { buildProgramMonitorPreview, type ProgramMonitorAudioLayer, type ProgramMonitorVisualLayer } from './programMonitorPreview';
import { titlePreviewLayout, titlesAt } from '../../../shared/titlePreviewLayout';
import { resolvedTitleStyle } from '../../../shared/captionStyle';
import { outputFrameFor } from '../../../shared/outputFrame';
import { DEFAULT_EXPORT_FRAME, EXPORT_FRAME_CHANGE_EVENT, readExportFramePreference } from './exportFramePreference';

type ProgramMonitorProps = {
  readonly editor: TimelineEditorController;
  readonly exportControl?: ReactNode;
};

type ProgramMonitorMediaElement = (HTMLAudioElement | HTMLVideoElement) & TimelineMediaEffectsElement;

type PreviewRequestAttempt = {
  completed: boolean;
  readonly id: number;
  timeoutId: number | null;
};

const PREVIEW_REQUEST_TIMEOUT_MS = 8_000;
const AUDIO_METER_PERCENT_SCALE = 100;

function clearPreviewRequestTimeout(attempt: PreviewRequestAttempt): void {
  if (attempt.timeoutId === null) return;
  window.clearTimeout(attempt.timeoutId);
  attempt.timeoutId = null;
}

// 30fps based timecode generator: HH:MM:SS:FF
function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((ms % 1000) / (1000 / 30));
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

function meterPercent(value: number): number {
  return Math.round(value * AUDIO_METER_PERCENT_SCALE);
}

function firstPreviewLayerAsset(
  visualLayer: ProgramMonitorVisualLayer | null,
  audioLayer: ProgramMonitorAudioLayer | undefined
) {
  return visualLayer?.asset ?? audioLayer?.asset ?? null;
}

export function ProgramMonitor({ editor, exportControl }: ProgramMonitorProps): ReactElement {
  const [previewLoadState, setPreviewLoadState] = useState<ProgramMonitorPreviewLoadState>(
    programMonitorPreviewLoadState({ type: 'loading' })
  );
  const [previewRetryRevision, setPreviewRetryRevision] = useState(0);
  const [readyAttemptId, setReadyAttemptId] = useState(0);
  const [scale, setScale] = useState('Fit');
  const [resolution, setResolution] = useState('Full');
  const [showSafeMargins, setShowSafeMargins] = useState(false);
  const [readyAssetId, setReadyAssetId] = useState<string | null>(null);
  /*
    The preview pane's size in CSS pixels, watched rather than assumed.

    A title's numbers are output-frame pixels, so drawing them needs to know how
    far the frame was shrunk to fit this pane — and the pane changes size every
    time a splitter moves, so a value read once is wrong for the rest of the
    session.
  */
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const frameRef = useRef<HTMLDivElement | null>(null);
  
  const mediaRef = useRef<ProgramMonitorMediaElement | null>(null);
  const currentPreviewAttemptRef = useRef<PreviewRequestAttempt | null>(null);
  const nextPreviewAttemptIdRef = useRef(0);
  const playbackRequestRevisionRef = useRef(0);
  const project = editor.project;
  const previewState = project === null ? null : buildProgramMonitorPreview({ assets: project.assets, playheadMs: editor.playheadMs, timeline: project.timeline });
  const primaryVisualLayer = previewState?.primaryVisualLayer ?? null;
  const primaryAudioLayer = previewState?.audioLayers[0];
  const asset = firstPreviewLayerAsset(primaryVisualLayer, primaryAudioLayer) ?? editor.selectedAsset;
  const assetId = asset?.id ?? null;
  const projectId = project?.id ?? null;
  const timelineView = project === null ? null : buildTimelineView(project.timeline, project.assets);
  const durationMs = timelineView?.durationMs ?? 0;
  const readyPreviewAssetId = previewLoadState.status === 'ready' ? readyAssetId : null;
  const activePreviewAssetId = primaryVisualLayer?.asset?.id ?? primaryAudioLayer?.asset?.id ?? null;
  const readyPreviewIsActivePlaybackClip = activePreviewAssetId !== null && readyPreviewAssetId === activePreviewAssetId;
  const activeClipEffects = readyPreviewIsActivePlaybackClip ? primaryVisualLayer?.effects ?? null : null;
  const mediaSourceTimeMs = readyPreviewIsActivePlaybackClip ? primaryVisualLayer?.sourceTimeMs ?? primaryAudioLayer?.sourceTimeMs ?? null : null;
  const mediaVolume = readyPreviewIsActivePlaybackClip ? primaryAudioLayer?.mediaVolume ?? primaryVisualLayer?.effects.volume ?? null : null;
  const activeVideoStyle: CSSProperties | undefined = activeClipEffects === null ? undefined : {
    opacity: activeClipEffects.opacity,
    transform: effectCssTransform(activeClipEffects),
    // The grade, shown where the change is meant to be visible. Undefined when
    // the clip is neutral, so the monitor carries no filter that does nothing.
    filter: effectCssFilter(activeClipEffects)
  };
  const blackOverlayStyle: CSSProperties | undefined = previewState === null || previewState.blackOpacity === 0 ? undefined : {
    background: '#000',
    inset: 0,
    opacity: previewState.blackOpacity,
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: 2
  };
  const levelL = editor.isPlaying && previewState !== null ? meterPercent(previewState.meterLeft) : 0;
  const levelR = editor.isPlaying && previewState !== null ? meterPercent(previewState.meterRight) : 0;

  const setMediaElement = useCallback((element: ProgramMonitorMediaElement | null): void => {
    if (mediaRef.current === element) return;
    playbackRequestRevisionRef.current += 1;
    mediaRef.current = element;
  }, []);

  useEffect(() => {
    setPreviewLoadState(programMonitorPreviewLoadState({ type: 'loading' }));
    setReadyAttemptId(0);
    setReadyAssetId(null);
    if (assetId === null || projectId === null) return;

    const attempt: PreviewRequestAttempt = {
      completed: false,
      id: nextPreviewAttemptIdRef.current + 1,
      timeoutId: null
    };
    nextPreviewAttemptIdRef.current = attempt.id;
    currentPreviewAttemptRef.current = attempt;

    const reportRequestFailure = (): void => {
      if (currentPreviewAttemptRef.current !== attempt || attempt.completed) return;
      attempt.completed = true;
      clearPreviewRequestTimeout(attempt);
      currentPreviewAttemptRef.current = null;
      setReadyAssetId(null);
      setPreviewLoadState(programMonitorPreviewLoadState({ type: 'error' }));
    };

    attempt.timeoutId = window.setTimeout(reportRequestFailure, PREVIEW_REQUEST_TIMEOUT_MS);
    void window.videoTool.getAssetPlaybackUrl({ projectId, assetId }).then((response) => {
      if (currentPreviewAttemptRef.current !== attempt || attempt.completed) return;
      if (!response.ok) {
        reportRequestFailure();
        return;
      }
      attempt.completed = true;
      clearPreviewRequestTimeout(attempt);
      setReadyAttemptId(attempt.id);
      setReadyAssetId(assetId);
      setPreviewLoadState(programMonitorPreviewLoadState({ type: 'ready', url: response.value.url }));
    }, reportRequestFailure);

    return () => {
      attempt.completed = true;
      clearPreviewRequestTimeout(attempt);
      if (currentPreviewAttemptRef.current === attempt) currentPreviewAttemptRef.current = null;
    };
  }, [assetId, previewRetryRevision, projectId]);

  const reportMediaFailure = useCallback((attemptId: number): void => {
    const attempt = currentPreviewAttemptRef.current;
    if (attempt === null || attempt.id !== attemptId) return;
    currentPreviewAttemptRef.current = null;
    setReadyAssetId(null);
    setPreviewLoadState(programMonitorPreviewLoadState({ type: 'error' }));
    editor.setIsPlaying(false);
  }, [editor.setIsPlaying]);

  const handleMediaEnded = useCallback((event: SyntheticEvent<ProgramMonitorMediaElement>): void => {
    if (mediaRef.current !== event.currentTarget) return;
    playbackRequestRevisionRef.current += 1;
    editor.setIsPlaying(false);
  }, [editor.setIsPlaying]);

  useEffect(() => {
    syncTimelineMediaTime(mediaRef.current, mediaSourceTimeMs);
  }, [editor.playheadMs, mediaSourceTimeMs, readyAttemptId]);

  useEffect(() => {
    syncTimelineMediaVolume({ media: mediaRef.current, volume: mediaVolume });
  }, [mediaVolume, readyAttemptId]);

  useEffect(() => {
    const media = mediaRef.current;
    const requestRevision = playbackRequestRevisionRef.current + 1;
    playbackRequestRevisionRef.current = requestRevision;

    syncTimelineMediaPlayback({
      media,
      shouldPlay: editor.isPlaying && readyPreviewIsActivePlaybackClip,
      onPlayRejected: () => {
        if (mediaRef.current !== media || playbackRequestRevisionRef.current !== requestRevision) return;
        editor.setIsPlaying(false);
      }
    });
  }, [editor.isPlaying, editor.setIsPlaying, readyPreviewIsActivePlaybackClip, readyAttemptId]);

  const stepFrame = (direction: 'forward' | 'backward'): void => {
    if (project === null) return;
    const frameMs = 1000 / 30; // 30 fps
    const targetMs = direction === 'forward' ? editor.playheadMs + frameMs : editor.playheadMs - frameMs;
    editor.setPlayheadMs(Math.max(0, targetMs));
  };

  const stopPlayback = (): void => {
    editor.setIsPlaying(false);
    editor.setPlayheadMs(0);
  };

  const retryPreview = (): void => {
    if (asset === null || project === null || previewLoadState.status !== 'error') return;
    setPreviewLoadState(programMonitorPreviewLoadState({ type: 'loading' }));
    setReadyAssetId(null);
    setPreviewRetryRevision((current) => current + 1);
  };

  useEffect(() => {
    const element = frameRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box !== undefined) setFrameSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visibleTitles = titlesAt(editor.project?.timeline.titles, editor.playheadMs);
  const [framePreference, setFramePreference] = useState(DEFAULT_EXPORT_FRAME);
  useEffect(() => {
    const projectId = editor.project?.id;
    setFramePreference(projectId === undefined ? DEFAULT_EXPORT_FRAME : readExportFramePreference(projectId));
    const onFrameChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly projectId: string }>).detail;
      if (projectId !== undefined && detail?.projectId === projectId) {
        setFramePreference(readExportFramePreference(projectId));
      }
    };
    window.addEventListener(EXPORT_FRAME_CHANGE_EVENT, onFrameChange);
    return () => window.removeEventListener(EXPORT_FRAME_CHANGE_EVENT, onFrameChange);
  }, [editor.project?.id]);
  const titleReferenceFrame = useMemo(
    () => editor.project === null
      ? null
      : outputFrameFor({ timeline: editor.project.timeline, assets: editor.project.assets, preference: framePreference }),
    [editor.project, framePreference]
  );

  let preview: ReactElement;
  if (asset === null || project === null) {
    preview = <div className="preview-frame__empty">Select an asset or place the playhead over a video clip.</div>;
  } else {
    switch (previewLoadState.status) {
      case 'loading':
        preview = <div className="preview-frame__empty">Preparing local preview.</div>;
        break;
      case 'error':
        preview = (
          <div className="preview-frame__empty" role="alert">
            <p>{previewLoadState.message}</p>
            <button className="button" type="button" onClick={retryPreview}>Retry preview</button>
          </div>
        );
        break;
      case 'ready': {
        if (readyAssetId !== asset.id) {
          preview = <div className="preview-frame__empty">Preparing local preview.</div>;
          break;
        }

        const onMediaFailure = (event: SyntheticEvent<ProgramMonitorMediaElement>): void => {
          if (mediaRef.current !== event.currentTarget) return;
          reportMediaFailure(readyAttemptId);
        };
        const mediaLabel = `${asset.kind === 'video' ? 'Video' : asset.kind === 'image' ? 'Image' : 'Audio'} preview: ${asset.displayName}`;
        if (asset.kind === 'video') {
          preview = <video ref={setMediaElement} key={readyAttemptId} src={previewLoadState.url} aria-label={mediaLabel} controls={false} playsInline style={activeVideoStyle} onAbort={onMediaFailure} onEnded={handleMediaEnded} onError={onMediaFailure} />;
        } else if (asset.kind === 'image') {
          preview = <img key={readyAttemptId} src={previewLoadState.url} alt={mediaLabel} style={activeVideoStyle} onError={() => reportMediaFailure(readyAttemptId)} />;
        } else {
          preview = (
            <div className="preview-frame__empty">
              <span>{mediaLabel}</span>
              <audio ref={setMediaElement} key={readyAttemptId} src={previewLoadState.url} aria-label={mediaLabel} controls={false} onAbort={onMediaFailure} onEnded={handleMediaEnded} onError={onMediaFailure} />
            </div>
          );
        }
        break;
      }
    }
  }

  return (
    <section className="program-monitor clip-controls" aria-labelledby="program-monitor-title">
      <h2 id="program-monitor-title" className="visually-hidden">Program Monitor</h2>

      <div className="monitor-container" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--space-3)', minHeight: 0 }}>
        {/* Preview Frame */}
        <div 
          ref={frameRef}
          className="editor-preview-frame" 
          role="group" 
          aria-label="Selected asset and active clip preview"
          style={{ position: 'relative', overflow: 'hidden' }}
        >
          {preview}
          {blackOverlayStyle === undefined ? null : <div aria-hidden="true" style={blackOverlayStyle} />}
          {/*
            Titles, over the picture and under the safe margins — the margins
            exist to be checked against the words, so they have to stay on top.
          */}
          {visibleTitles.length > 0 && (
            <div className="preview-titles" aria-label="Titles at the playhead">
              {visibleTitles.map((title) => {
                const layout = titlePreviewLayout(title, frameSize, titleReferenceFrame ?? undefined);
                const titleStyle = resolvedTitleStyle(title);
                const background = titleStyle.backgroundOpacity <= 0
                  ? 'transparent'
                  : `${titleStyle.backgroundColor}${Math.round(titleStyle.backgroundOpacity * 255).toString(16).padStart(2, '0')}`;
                return (
                  <span
                    key={title.id}
                    className="preview-title"
                    style={{
                      color: title.color,
                      fontSize: `${layout.fontSizePx}px`,
                      fontWeight: titleStyle.fontWeight === 'bold' ? 700 : 400,
                      backgroundColor: background,
                      padding: `${layout.paddingPx}px`,
                      WebkitTextStroke: layout.outlineWidthPx > 0 ? `${layout.outlineWidthPx}px ${titleStyle.outlineColor}` : undefined,
                      paintOrder: 'stroke fill',
                      transform: `translate(${layout.offsetXPx}px, ${layout.offsetYPx}px)`
                    }}
                  >
                    {title.text}
                  </span>
                );
              })}
            </div>
          )}
          {showSafeMargins && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
              {/* Action Safe (90%) */}
              <div style={{ position: 'absolute', inset: '5%', border: '1px dashed rgba(6, 182, 212, 0.4)' }} />
              {/* Title Safe (80%) */}
              <div style={{ position: 'absolute', inset: '10%', border: '1px dashed rgba(99, 102, 241, 0.4)' }} />
              {/* Center Crosshair */}
              <div style={{ position: 'absolute', top: '50%', left: '25%', right: '25%', height: '1px', background: 'var(--color-line-strong)', transform: 'translateY(-50%)' }} />
              <div style={{ position: 'absolute', left: '50%', top: '25%', bottom: '25%', width: '1px', background: 'var(--color-line-strong)', transform: 'translateX(-50%)' }} />
            </div>
          )}
        </div>

        {/* Professional DB Level Meter (Stereo) */}
        <div 
          className="audio-meter"
          style={{
            width: '18px',
            background: 'var(--input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xs)',
            padding: '3px 2px',
            display: 'flex',
            justifyContent: 'space-between',
            height: '100%'
          }}
          title="Stereo db output level"
        >
          {/* L Channel */}
          <div style={{ width: '5px', height: '100%', background: 'var(--muted)', borderRadius: '2px', position: 'relative', overflow: 'hidden' }}>
            <div 
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: `${levelL}%`,
                background: 'linear-gradient(to top, #10b981 0%, #10b981 70%, #f59e0b 70%, #f59e0b 90%, #ef4444 90%)',
                transition: 'height 80ms ease'
              }}
            />
          </div>
          {/* R Channel */}
          <div style={{ width: '5px', height: '100%', background: 'var(--muted)', borderRadius: '2px', position: 'relative', overflow: 'hidden' }}>
            <div 
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: `${levelR}%`,
                background: 'linear-gradient(to top, #10b981 0%, #10b981 70%, #f59e0b 70%, #f59e0b 90%, #ef4444 90%)',
                transition: 'height 80ms ease'
              }}
            />
          </div>
        </div>
      </div>

      {/* Flat under-canvas transport row: timecode left, playback centered, view options right */}
      <div
        className="monitor-controls"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-2) 0',
          marginTop: 'var(--space-1)'
        }}
      >
        {/* Left: current / total timecode */}
        <div
          className="timecode-display"
          style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', minWidth: 0 }}
          title="Current playhead position (HH:MM:SS:FF)"
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', fontWeight: 500, color: 'var(--text-strong)' }}>
            {formatTimecode(editor.playheadMs)}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', color: 'var(--text-weaker)' }}>
            / {formatTimecode(durationMs)}
          </span>
        </div>

        {/* Center: playback controls */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-1)' }}>
          <button
            className="button button--ghost"
            style={{ padding: '2px 8px', minHeight: '26px' }}
            aria-label="Step backward one frame"
            title="Step backward 1 frame"
            onClick={() => stepFrame('backward')}
            disabled={project === null}
          >
            ⏮
          </button>
          <button
            className="button button--ghost"
            style={{ padding: '2px 10px', minHeight: '26px', minWidth: '44px', fontSize: 'var(--text-body)' }}
            aria-label={editor.isPlaying ? 'Pause timeline playback' : 'Play timeline playback'}
            title="Play / Pause"
            onClick={() => editor.setIsPlaying(!editor.isPlaying)}
            disabled={project === null}
          >
            {editor.isPlaying ? '⏸' : '▶'}
          </button>
          <button
            className="button button--ghost"
            style={{ padding: '2px 8px', minHeight: '26px' }}
            aria-label="Stop timeline playback and return to start"
            title="Stop playback"
            onClick={stopPlayback}
            disabled={project === null}
          >
            ⏹
          </button>
          <button
            className="button button--ghost"
            style={{ padding: '2px 8px', minHeight: '26px' }}
            aria-label="Step forward one frame"
            title="Step forward 1 frame"
            onClick={() => stepFrame('forward')}
            disabled={project === null}
          >
            ⏭
          </button>
        </div>

        {/* Right: view options */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--space-1)' }}>
          {/* Safe Margins Button */}
          <button
            type="button"
            aria-label="Toggle broadcast safe margins guide"
            aria-pressed={showSafeMargins}
            onClick={() => setShowSafeMargins(!showSafeMargins)}
            style={{
              background: showSafeMargins ? 'var(--surface-control-selected)' : 'transparent',
              border: 'none',
              color: showSafeMargins ? 'var(--color-primary)' : 'var(--text-weak)',
              fontSize: 'var(--text-micro)',
              padding: '2px 8px',
              borderRadius: 'var(--radius-xs)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '22px',
              transition: 'background var(--transition-fast), color var(--transition-fast)'
            }}
            title="Toggle Broadcast Safe Margins Guide"
          >
            Grid
          </button>
          {/* Zoom/Fit Selector */}
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value)}
            aria-label="Preview scale"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-weak)',
              fontSize: 'var(--text-micro)',
              padding: '2px 2px',
              borderRadius: 'var(--radius-xs)',
              cursor: 'pointer'
            }}
          >
            <option value="Fit">Fit</option>
            <option value="50%">50%</option>
            <option value="100%">100%</option>
          </select>

          {/* Quality Selector */}
          <select
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            aria-label="Preview playback quality"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-weak)',
              fontSize: 'var(--text-micro)',
              padding: '2px 2px',
              borderRadius: 'var(--radius-xs)',
              cursor: 'pointer'
            }}
          >
            <option value="Full">Full</option>
            <option value="1/2">1/2</option>
            <option value="1/4">1/4</option>
          </select>
          {exportControl}
        </div>
      </div>
    </section>
  );
}
