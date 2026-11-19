import { GitActionMenuItems, GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";
import { actionsWithoutPrimary } from "@/git/policy";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
  menuOnly?: boolean;
}

export function WorkspaceActions({ serverId, cwd, menuOnly }: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return <GitActionsSplitButton gitActions={gitActions} menuOnly={menuOnly} menuTrigger="icon" />;
}

export function WorkspaceGitMenuItems({ serverId, cwd }: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({ serverId, cwd, icons: GIT_ACTION_ICONS });
  const actions = [
    ...(gitActions.primary ? [gitActions.primary] : []),
    ...actionsWithoutPrimary(gitActions),
  ];
  if (actions.length === 0) return null;
  return (
    <>
      <GitActionMenuItems actions={actions} />
      <DropdownMenuSeparator />
    </>
  );
}
