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

export const DebugPanel = () => {
  const { dispatch, moveToSector } = useGameManager();
  return (
    <Card
      noElbows={false}
      background="scanlines"
      className="flex w-full h-full"
    >
      <CardHeader>
        <PanelTitle>Debug</PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 overflow-y-auto">
        <Button
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
          Set Ship to Kestral
        </Button>
        <Button
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
        <Divider decoration="plus" className="my-2" />
        <Button
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
