import type { LocalProjectSnapshot, MediaAsset } from '../../../shared/timelineTypes';

const LEFT_DOCK_TAB_IDS = ['project', 'media'] as const;
const INSPECTOR_DOCK_TAB_IDS = ['selection', 'asset'] as const;

export const LEFT_EDITOR_DOCK_TAB_IDS = LEFT_DOCK_TAB_IDS;
export const INSPECTOR_EDITOR_DOCK_TAB_IDS = INSPECTOR_DOCK_TAB_IDS;
export const EDITOR_LEFT_DOCK_TAB_IDS = LEFT_DOCK_TAB_IDS;
export const EDITOR_INSPECTOR_DOCK_TAB_IDS = INSPECTOR_DOCK_TAB_IDS;

export type EditorLeftDockTabId = (typeof LEFT_DOCK_TAB_IDS)[number];
export type EditorDockTabId = (typeof LEFT_DOCK_TAB_IDS)[number] | (typeof INSPECTOR_DOCK_TAB_IDS)[number];

type EditorLeftDockIdentityInput = {
  readonly hasProject: boolean;
  readonly selectedAssetId: string;
};

export type EditorDockTab = {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type EditorDockTabs = {
  readonly left: readonly EditorDockTab[];
  readonly inspector: readonly EditorDockTab[];
};

export type EditorDockNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

type EditorDockNavigationInput = {
  readonly currentTabId: string;
  readonly key: EditorDockNavigationKey;
  readonly tabs: readonly EditorDockTab[];
};

function isEnabledTab(tab: EditorDockTab): boolean {
  return tab.disabled !== true;
}

function findBoundaryTabId(tabs: readonly EditorDockTab[], fromStart: boolean): string | null {
  const orderedTabs = fromStart ? tabs : [...tabs].reverse();
  return orderedTabs.find(isEnabledTab)?.id ?? null;
}

function findNextEnabledTabId(tabs: readonly EditorDockTab[], currentIndex: number, step: 1 | -1): string | null {
  for (let offset = 1; offset <= tabs.length; offset += 1) {
    const nextIndex = (currentIndex + step * offset + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (nextTab !== undefined && isEnabledTab(nextTab)) return nextTab.id;
  }
  return null;
}

function findCurrentTabIndex(tabs: readonly EditorDockTab[], currentTabId: string, step: 1 | -1): number {
  if (step === 1) {
    return tabs.findIndex((tab) => tab.id === currentTabId);
  }
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    if (tabs[index]?.id === currentTabId) return index;
  }
  return -1;
}

export function getDefaultEditorDockTabs(project: LocalProjectSnapshot): EditorDockTabs {
  const hasPendingAssetMetadata = project.assets.length === 0 || assetsNeedingMetadata(project.assets).length > 0;

  return {
    left: [
      { id: 'project', label: 'Project' },
      { id: 'media', label: 'Media' }
    ],
    inspector: [
      { id: 'selection', label: 'Selection' },
      // Project settings moved to the workspace tab line; the inspector is for
      // whatever is under the cursor.
      { id: 'asset', label: 'Asset', disabled: hasPendingAssetMetadata }
    ]
  };
}

export function getDefaultEditorLeftDockTabId({ hasProject, selectedAssetId }: EditorLeftDockIdentityInput): EditorLeftDockTabId {
  if (selectedAssetId.length > 0) return 'media';
  return hasProject ? 'media' : 'project';
}

export function getNextEditorDockTabId({ currentTabId, key, tabs }: EditorDockNavigationInput): string {
  if (key === 'Home') return findBoundaryTabId(tabs, true) ?? currentTabId;
  if (key === 'End') return findBoundaryTabId(tabs, false) ?? currentTabId;

  const step: 1 | -1 = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const currentIndex = findCurrentTabIndex(tabs, currentTabId, step);
  if (currentIndex === -1) {
    return findBoundaryTabId(tabs, step === 1) ?? currentTabId;
  }

  return findNextEnabledTabId(tabs, currentIndex, step) ?? currentTabId;
}

export function assetsNeedingMetadata(assets: readonly MediaAsset[]): readonly MediaAsset[] {
  return assets.filter((asset) => asset.kind !== 'image' && asset.metadata === null);
}

export function filterPendingAssetsForDock(assets: readonly MediaAsset[]): readonly MediaAsset[] {
  return assets.filter((asset) => asset.kind === 'image' || asset.metadata !== null);
}
