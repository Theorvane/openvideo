import {
  TIMELINE_VALIDATION_LIMITS,
  getBoundedNonNegative,
  getFiniteNonNegative,
  getMediaKind,
  getMimeType,
  getOpaqueId,
  getRelativePath,
  getTrimmedString,
  hasAllowedKeys,
  isPlainRecord,
  isUnknownArray
} from './timelineValidationPrimitives';
import type {
  CreateProjectInput,
  DetachVideoAudioInput,
  DeleteProjectInput,
  GetAssetPlaybackUrlInput,
  ImportRecordingResultAssetInput,
  ImportProjectAssetsInput,
  ImportTtsResultAssetInput,
  ImportMediaInput,
  ListProjectsInput,
  MediaKind,
  OpenProjectInput,
  SaveTimelineInput,
  UpdateAssetMetadataInput
} from './timelineTypes';
export { migrateTimelineDocumentV1, migrateTimelineDocumentV2, parseTimelineDocument } from './timelineDocumentValidators';
import { parseTimelineDocument } from './timelineDocumentValidators';

export function parseCreateProjectInput(value: unknown): CreateProjectInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['name'])) {
    return null;
  }
  const name = getTrimmedString(value, 'name', TIMELINE_VALIDATION_LIMITS.nameLength);
  return name === null ? null : { name };
}

export function parseListProjectsInput(value: unknown): ListProjectsInput | null {
  if (value === undefined) {
    return {};
  }
  return isPlainRecord(value) && Object.keys(value).length === 0 ? {} : null;
}

export function parseOpenProjectInput(value: unknown): OpenProjectInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  return projectId === null ? null : { projectId };
}

export function parseDeleteProjectInput(value: unknown): DeleteProjectInput | null {
  return parseOpenProjectInput(value);
}

export function parseImportProjectAssetsInput(value: unknown): ImportProjectAssetsInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'acceptedKinds'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  if (projectId === null) {
    return null;
  }
  if (value.acceptedKinds === undefined) {
    return { projectId };
  }
  if (!isUnknownArray(value.acceptedKinds) || value.acceptedKinds.length === 0 || value.acceptedKinds.length > 2) {
    return null;
  }
  const acceptedKinds: MediaKind[] = [];
  for (const kind of value.acceptedKinds) {
    const parsedKind = getMediaKind({ kind }, 'kind') ?? (kind === 'image' ? 'image' : null);
    if (parsedKind === null) {
      return null;
    }
    acceptedKinds.push(parsedKind);
  }
  return { projectId, acceptedKinds: [...new Set(acceptedKinds)] };
}

export function parseImportRecordingResultAssetInput(value: unknown): ImportRecordingResultAssetInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'sessionId'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const sessionId = getOpaqueId(value, 'sessionId');
  return projectId === null || sessionId === null ? null : { projectId, sessionId };
}

export function parseImportTtsResultAssetInput(value: unknown): ImportTtsResultAssetInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'jobId'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const jobId = getOpaqueId(value, 'jobId');
  return projectId === null || jobId === null ? null : { projectId, jobId };
}

export function parseImportMediaInput(value: unknown): ImportMediaInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'displayName', 'projectRelativePath', 'kind', 'mimeType', 'byteLength'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const displayName = getTrimmedString(value, 'displayName', TIMELINE_VALIDATION_LIMITS.nameLength);
  const projectRelativePath = getRelativePath(value, 'projectRelativePath');
  const mimeType = getMimeType(value, 'mimeType');
  const kind = getMediaKind(value, 'kind') ?? (
    value.kind === 'image' && (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp')
      ? 'image'
      : null
  );
  const byteLength = getFiniteNonNegative(value, 'byteLength');
  return projectId === null || displayName === null || projectRelativePath === null || kind === null || mimeType === null || byteLength === null
    ? null
    : { projectId, displayName, projectRelativePath, kind, mimeType, byteLength };
}

export function parseUpdateAssetMetadataInput(value: unknown): UpdateAssetMetadataInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'assetId', 'durationMs', 'width', 'height'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const assetId = getOpaqueId(value, 'assetId');
  const durationMs = getBoundedNonNegative(value, 'durationMs', TIMELINE_VALIDATION_LIMITS.durationMs);
  const width = value.width === undefined ? undefined : getBoundedNonNegative(value, 'width', TIMELINE_VALIDATION_LIMITS.mediaDimensionPixels);
  const height = value.height === undefined ? undefined : getBoundedNonNegative(value, 'height', TIMELINE_VALIDATION_LIMITS.mediaDimensionPixels);
  if (projectId === null || assetId === null || durationMs === null || width === null || height === null) {
    return null;
  }
  return { projectId, assetId, durationMs, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
}

export function parseSaveTimelineInput(value: unknown): SaveTimelineInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'timeline'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const timeline = parseTimelineDocument(value.timeline);
  return projectId === null || timeline === null ? null : { projectId, timeline };
}

export function parseGetAssetPlaybackUrlInput(value: unknown): GetAssetPlaybackUrlInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'assetId'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const assetId = getOpaqueId(value, 'assetId');
  return projectId === null || assetId === null ? null : { projectId, assetId };
}

export function parseDetachVideoAudioInput(value: unknown): DetachVideoAudioInput | null {
  if (!isPlainRecord(value) || !hasAllowedKeys(value, ['projectId', 'assetId'])) {
    return null;
  }
  const projectId = getOpaqueId(value, 'projectId');
  const assetId = getOpaqueId(value, 'assetId');
  return projectId === null || assetId === null ? null : { projectId, assetId };
}
