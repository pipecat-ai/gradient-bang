import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import type { Ship } from "../GameContext";
import { useGameManager } from "../hooks/useGameManager";
import { usePanelRef } from "../hooks/usePanelRef";
import { useUI } from "../hooks/useUI";

export const DebugPanel = () => {
  const { dispatch, moveToSector } = useGameManager();
  const { highlightPanel, switchAndHighlight } = useUI();
  const panelRef = usePanelRef("debug");
  return (
    <Card
      ref={panelRef}
      noElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Debug</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <Button
          size="sm"
          onClick={() =>
            dispatch({
              type: "SET_SHIP",
              ship: {
                name: "kestrel",
                warp: 50,
                warpCapacity: 100,
                capcity: 100,
              } as Ship,
            })
          }
        >
          Set Ship to Kestrel
        </Button>
        <Button
          size="sm"
          onClick={() =>
            dispatch({
              type: "ADD_CREDITS",
              credits: 1000,
            })
          }
        >
          Give 1000 credits
        </Button>
        <Button
          size="sm"
          onClick={() => {
            moveToSector("777", {
              port_info: {
                name: "Debug Port",
              },
            });
          }}
        >
          Arrive at Port
        </Button>
        <Button
          size="sm"
          onClick={() => {
            switchAndHighlight("movement_history");
          }}
        >
          Switch & Highlight Movement
        </Button>
        <Button
          size="sm"
          onClick={() => {
            highlightPanel("task_output");
          }}
        >
          Highlight Task Panel
        </Button>
        <Button
          size="sm"
          onClick={() => {
            highlightPanel("debug");
          }}
        >
          Highlight Current Panel
        </Button>
        <Button
          size="sm"
          onClick={() => {
            highlightPanel(null);
          }}
        >
          Clear Highlight
        </Button>
        <Divider decoration="plus" className="my-2" />
        <Button
          size="sm"
          variant="destructive"
          onClick={() =>
            dispatch({
              type: "RESET_GAME",
            })
          }
        >
          Reset Game
        </Button>
      </CardContent>
    </Card>
  );
};
