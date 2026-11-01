import { createContext, useContext } from 'react';
import type { ComponentMetadata } from '../../types/canvas';
import type { SystemSummary } from './systemSummary';

/** What the editor lets a system box do; absent on read-only canvases. Ids are those of the nodes on screen. */
export interface SystemActions {
  /** Navigates into the team design. */
  open: (id: string) => void;
  /** Expands the box in place, or collapses its frame. */
  toggle: (id: string) => void;
}

export const SystemActionsContext = createContext<SystemActions | null>(null);

export const useSystemActions = () => useContext(SystemActionsContext);

/** A node's data with its system summary, set by the editor on system boxes and the frames of expanded ones. */
export type SystemNodeData = ComponentMetadata & { system?: SystemSummary };
