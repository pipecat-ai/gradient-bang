import { RTVIEvent } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import React, {
  createContext,
  useCallback,
  useReducer,
  type ReactNode,
} from "react";
import usePortStore from "./stores/port";
import useStarfieldStore from "./stores/starfield";

export type PanelId =
  | "movement_history"
  | "ports_discovered"
  | "port"
  | "task_output"
  | "ship";

interface UIState {
  highlightedPanel: PanelId | null;
  panelRefs: Record<PanelId, HTMLElement | null>;
}

type UIAction =
  | { type: "SET_HIGHLIGHTED_PANEL"; panel: PanelId | null }
  | { type: "SET_PANEL_REF"; id: PanelId; ref: HTMLElement | null };

const initialState: UIState = {
  highlightedPanel: null,
  panelRefs: {
    movement_history: null,
    ports_discovered: null,
    port: null,
    ship: null,
    task_output: null,
  },
};

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "SET_HIGHLIGHTED_PANEL":
      return {
        ...state,
        highlightedPanel: action.panel,
      };

    case "SET_PANEL_REF":
      return {
        ...state,
        panelRefs: {
          ...state.panelRefs,
          [action.id]: action.ref,
        },
      };

    default:
      return state;
  }
}

interface UIContextType {
  ui: UIState;
  highlightPanel: (panel: PanelId | null) => void;
  registerPanelRef: (id: PanelId, ref: HTMLElement | null) => void;
  resetActivePanels: () => void;
  switchAndHighlight: (panel: PanelId) => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export { UIContext };

interface UIProviderProps {
  children: ReactNode;
}

export const UIProvider: React.FC<UIProviderProps> = ({ children }) => {
  const [ui, dispatch] = useReducer(uiReducer, initialState);
  const { getInstance } = useStarfieldStore();
  const portStore = usePortStore();
  const highlightPanel = useCallback(
    (panel: PanelId | null) => {
      dispatch({ type: "SET_HIGHLIGHTED_PANEL", panel });
    },
    [dispatch]
  );

  const registerPanelRef = useCallback(
    (id: PanelId, ref: HTMLElement | null) => {
      dispatch({ type: "SET_PANEL_REF", id, ref });
    },
    [dispatch]
  );

  const switchAndHighlight = useCallback(
    (panel: PanelId) => {
      // First, set the highlighted panel (this will trigger panel switch)
      dispatch({ type: "SET_HIGHLIGHTED_PANEL", panel });

      // The panel switch will happen in the next render cycle
      // The highlight overlay will find the element once it's rendered
    },
    [dispatch]
  );

  const resetActivePanels = useCallback(() => {
    portStore.setActive(false);
  }, [portStore]);

  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (data: Record<string, unknown>) => {
        if ("ui-action" in data) {
          // Always reset any active HUD panels on UI action
          resetActivePanels();
          const action = data["ui-action"];
          switch (action) {
            /* SHOW PANEL */
            case "show_panel":
              console.log("[PANEL] show_panel", data);
              // --- TRADE PANEL
              if (data.panel === "trade") {
                // Select port game object in Starfield
                const instance = getInstance();
                if (!instance) return;
                const go = instance.getAllGameObjects()[0];
                if (!go) return;
                instance.selectGameObject(go.id);
                portStore.setActive(true);
              }
              highlightPanel(data.panel as PanelId);
              break;
            default:
              console.warn("Unhandled ui action", action);
              break;
          }
        }
      },
      [highlightPanel, getInstance, portStore, resetActivePanels]
    )
  );
  const value: UIContextType = {
    ui,
    highlightPanel,
    registerPanelRef,
    resetActivePanels,
    switchAndHighlight,
  };

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
};
