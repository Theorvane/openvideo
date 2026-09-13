import { useState, type CSSProperties, type ReactElement } from 'react';

import { formatBytes, formatDuration } from '../format';
import type { MediaAsset } from '../../../shared/timelineTypes';
import { mediaAssetReady } from './editorTimelineView';
import type { TimelineEditorController } from './useTimelineEditor';

type AssetBinProps = {
  readonly editor: TimelineEditorController;
};

type AssetViewMode = 'grid' | 'list';

const TIMELINE_DRAG_TYPE = 'application/x-window-loom-timeline';

const COMPACT_PANEL_STYLE = {
  gap: 'var(--space-2)',
  padding: 'var(--space-3)'
} as const satisfies CSSProperties;

function assetDurationLabel(asset: MediaAsset, failureMessage: string | undefined): string {
  if (failureMessage !== undefined) return failureMessage;
  if (asset.kind === 'image') return 'Still image';
  if (asset.metadata === null) return 'Reading metadata';
  return formatDuration(asset.metadata.durationMs);
}

function assetGlyph(asset: MediaAsset): string {
  if (asset.kind === 'video') return '🎬';
  if (asset.kind === 'image') return '🖼️';
  return '🎵';
}

export function AssetBin({ editor }: AssetBinProps): ReactElement {
  const project = editor.project;
  const [viewMode, setViewMode] = useState<AssetViewMode>('grid');

  const onAssetDragStart = (event: React.DragEvent, assetId: string): void => {
    event.dataTransfer.setData(TIMELINE_DRAG_TYPE, JSON.stringify({ kind: 'asset', assetId }));
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <section className="asset-bin" aria-labelledby="assets-title" style={COMPACT_PANEL_STYLE}>
      {/* Slim dock header: title left, view toggle right */}
      <div className="panel-heading asset-bin__header">
        <h2 id="assets-title" className="asset-bin__title">Media</h2>
        <div className="asset-bin__view-toggle" role="group" aria-label="Media view mode">
          <button
            className={`asset-bin__view-button${viewMode === 'grid' ? ' asset-bin__view-button--active' : ''}`}
            type="button"
            aria-pressed={viewMode === 'grid'}
            title="Grid view"
            onClick={() => setViewMode('grid')}
          >
            ▦
          </button>
          <button
            className={`asset-bin__view-button${viewMode === 'list' ? ' asset-bin__view-button--active' : ''}`}
            type="button"
            aria-pressed={viewMode === 'list'}
            title="List view"
            onClick={() => setViewMode('list')}
          >
            ☰
          </button>
        </div>
      </div>

      {/* Compact import toolbar */}
      <div className="asset-bin__toolbar">
        <button className="button button--ghost asset-bin__toolbar-button" type="button" onClick={() => void editor.importAssets(['video'])} disabled={project === null || editor.isBusy}>
          + Video
        </button>
        <button className="button button--ghost asset-bin__toolbar-button" type="button" onClick={() => void editor.importAssets(['audio'])} disabled={project === null || editor.isBusy}>
          + Audio
        </button>
        <button className="button button--ghost asset-bin__toolbar-button" type="button" onClick={() => void editor.importAssets(['image'])} disabled={project === null || editor.isBusy}>
          + Image
        </button>
        <button className="button button--primary asset-bin__toolbar-button" type="button" onClick={editor.placeSelectedAsset} disabled={editor.selectedAsset === null || !mediaAssetReady(editor.selectedAsset)}>
          Place
        </button>
      </div>

      {project === null ? (
        <div className="empty-slate">Create or open a project before importing local media.</div>
      ) : project.assets.length === 0 ? (
        <button
          className="asset-bin__dropzone"
          type="button"
          onClick={() => void editor.importAssets()}
          disabled={editor.isBusy}
        >
          <span aria-hidden="true" className="asset-bin__dropzone-icon">⬆</span>
          <strong>Import media</strong>
          <span>Local video, audio and images stay on this machine.</span>
        </button>
      ) : viewMode === 'grid' ? (
        <div className="asset-grid asset-grid--tiles" aria-label="Imported project assets">
          {project.assets.map((asset) => {
            const failureMessage = editor.metadataProbeFailuresByAssetId[asset.id];
            const selected = editor.selectedAssetId === asset.id;

            return (
              <div key={asset.id} className="asset-tile-entry">
                <button
                  className={`asset-tile${selected ? ' asset-tile--selected' : ''}`}
                  draggable={mediaAssetReady(asset)}
                  type="button"
                  onClick={() => editor.setSelectedAssetId(asset.id)}
                  onDragStart={(event) => onAssetDragStart(event, asset.id)}
                  title={asset.displayName}
                >
                  <span className={`asset-tile__preview asset-tile__preview--${asset.kind}`} aria-hidden="true">
                    <span className="asset-tile__glyph">{assetGlyph(asset)}</span>
                    <span className={`asset-tile__kind asset-card__kind asset-card__kind--${asset.kind}`}>{asset.kind}</span>
                    <span className="asset-tile__duration">{assetDurationLabel(asset, failureMessage)}</span>
                  </span>
                  <strong className="asset-tile__name">{asset.displayName}</strong>
                  <small className="asset-tile__meta">{formatBytes(asset.byteLength)}</small>
                </button>
                {selected && failureMessage !== undefined ? (
                  <button className="button asset-bin__retry" type="button" onClick={() => editor.retryAssetMetadataProbe(asset.id)}>Retry metadata</button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="asset-grid asset-grid--list" aria-label="Imported project assets">
          {project.assets.map((asset) => {
            const failureMessage = editor.metadataProbeFailuresByAssetId[asset.id];
            const selected = editor.selectedAssetId === asset.id;

            return (
              <div key={asset.id} className="asset-tile-entry">
                <button
                  className={`asset-row${selected ? ' asset-row--selected' : ''}`}
                  draggable={mediaAssetReady(asset)}
                  type="button"
                  onClick={() => editor.setSelectedAssetId(asset.id)}
                  onDragStart={(event) => onAssetDragStart(event, asset.id)}
                  title={asset.displayName}
                >
                  <span className={`asset-row__thumb asset-row__thumb--${asset.kind}`} aria-hidden="true">{assetGlyph(asset)}</span>
                  <span className="asset-row__body">
                    <strong className="asset-row__name">{asset.displayName}</strong>
                    <small className="asset-row__meta">{asset.kind} · {formatBytes(asset.byteLength)}</small>
                  </span>
                  <span className="asset-row__duration">{assetDurationLabel(asset, failureMessage)}</span>
                </button>
                {selected && failureMessage !== undefined ? (
                  <button className="button asset-bin__retry" type="button" onClick={() => editor.retryAssetMetadataProbe(asset.id)}>Retry metadata</button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
