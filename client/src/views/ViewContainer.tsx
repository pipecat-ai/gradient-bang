import useGameStore from "@/stores/game";
import { usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";
import Connect from "@views/Connect";
import Error from "@views/Error";
import Game from "@views/Game";
import Title from "@views/Title";
import { useEffect, useRef, useState } from "react";

export const ViewContainer = ({
  error,
  onConnect,
}: {
  onConnect?: () => void;
  error?: string | null;
}) => {
  const [start, setStart] = useState(false);
  const settings = useGameStore.use.settings();
  const { isConnected } = usePipecatConnectionState();
  const hasConnected = useRef(false);

  // Call onConnect only once when we're ready (past title screen)
  const shouldConnect = settings.bypassTitleScreen || start;

  useEffect(() => {
    if (shouldConnect && !hasConnected.current && onConnect) {
      onConnect();
      hasConnected.current = true;
    }
  }, [shouldConnect, onConnect]);

  // Show errors first
  if (error) {
    return <Error>{error}</Error>;
  }

  // Show title screen if not bypassed
  if (!settings.bypassTitleScreen && !start) {
    return <Title onStart={() => setStart(true)} />;
  }

  // Show connectivity view
  if (!isConnected) {
    return <Connect />;
  }
  // Away we go...
  return <Game />;
};

export default ViewContainer;
