interface DesktopSidebarToggleInput {
  isAgentListOpen: boolean;
  isExplorerOpen: boolean;
  openAgentList: () => void;
  resetAgentList: () => void;
  toggleExplorer: () => void;
}

/**
 * "Toggle both sidebars" collapses the workspace to just its content when
 * anything is showing, and restores both when nothing is. Reset navigation even
 * when its overlay is closed: saved dock intent must not reappear as Explorer closes.
 * Only toggle Explorer when it is on the wrong side of the intent.
 */
export function toggleDesktopSidebarsWithCheckoutIntent(input: DesktopSidebarToggleInput): boolean {
  const shouldOpen = !input.isAgentListOpen && !input.isExplorerOpen;

  if (shouldOpen) {
    input.openAgentList();
  } else {
    input.resetAgentList();
  }
  if (input.isExplorerOpen !== shouldOpen) {
    input.toggleExplorer();
  }
  return true;
}
