import {
  Button,
  Card,
  CardContent,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";

export const Connect = ({ onConnect }: { onConnect: () => void }) => {
  const { isConnecting, isConnected } = usePipecatConnectionState();

  return (
    <Card size="xl" background="stripes" className="shadow-xlong">
      <CardContent className="flex flex-col gap-2 min-w-96">
        <Button
          onClick={onConnect}
          disabled={isConnecting || isConnected}
          isLoading={isConnecting}
          isFullWidth
          className="font-extrabold animate-pulse"
          size="lg"
        >
          {isConnecting
            ? ""
            : isConnected
            ? "Connected"
            : "▶ Initiate Connection ◀"}
        </Button>
      </CardContent>
    </Card>
  );
};
