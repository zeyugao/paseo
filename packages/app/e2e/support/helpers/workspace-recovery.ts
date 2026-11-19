import { expect, type Page } from "@playwright/test";
import { openChangesPanel } from "./branch-switcher";
import { workspaceDeckEntryLocator } from "./workspace-ui";

export async function restoreArchivedWorkspace(
  page: Page,
  target: { serverId: string; workspaceId: string },
): Promise<void> {
  const workspace = workspaceDeckEntryLocator(page, target.serverId, target.workspaceId);
  await workspace.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(workspace.getByTestId("workspace-recovery-action")).toHaveCount(0);
}

export async function restoreWorkspaceFromHistory(
  page: Page,
  serverId: string,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  // History rows have no unique accessible name; their stable ID identifies the session.
  await page.getByTestId(`agent-row-${serverId}-${agentId}`).click();
  await restoreArchivedWorkspace(page, { serverId, workspaceId });
}

export async function expectCommittedFile(page: Page, filename: string): Promise<void> {
  await openChangesPanel(page);
  await expect(page.getByText(filename, { exact: true }).filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectCommittedFileAfterReload(page: Page, filename: string): Promise<void> {
  await expectCommittedFile(page, filename);
  await page.reload();
  await expectCommittedFile(page, filename);
}
