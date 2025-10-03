import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { useGameManager } from "../hooks/useGameManager";
import { usePanelRef } from "../hooks/usePanelRef";
import { useUI } from "../hooks/useUI";

export const DebugPanel = () => {
  const { game, dispatch, getStatusFromServer } = useGameManager();
  const { highlightPanel, switchAndHighlight } = useUI();
  const panelRef = usePanelRef("debug");
  return (
    <Card
      ref={panelRef}
      withElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Debug</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <Button
          size="sm"
          onClick={() => {
            console.log("game", game);
          }}
        >
          Get Status
        </Button>
        <Button
          size="sm"
          onClick={() => {
            getStatusFromServer();
          }}
        >
          Get status from Server
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
