import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * Portal host for page-supplied trailing actions in the workspace
 * chrome header (`TopBar`). The provider sets the host element (a
 * `<div>` rendered inside the topbar); consumers portal their action
 * buttons into it via `<HeaderActions>`.
 *
 * This keeps the data ownership boundary clean: each page owns its
 * own action handlers (refresh, dispatch, …) but renders them into a
 * single shared spot at the top of the shell.
 */
export const HeaderActionsContext = createContext<HTMLElement | null>(null);

export function HeaderActions({ children }: { children: ReactNode }) {
  const host = useContext(HeaderActionsContext);
  if (!host) return null;
  return createPortal(children, host);
}
