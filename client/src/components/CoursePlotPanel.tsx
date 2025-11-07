import useGameStore from "@/stores/game";
import {
  Card,
  CardContent,
  CardHeader,
  PanelTitle,
} from "@pipecat-ai/voice-ui-kit";
import { Button } from "./primitives/Button";

export const CoursePlotPanel = () => {
  const coursePlot = useGameStore.use.course_plot?.();
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.();
  return (
    <Card>
      <CardHeader>
        <PanelTitle>Active course plot:</PanelTitle>
      </CardHeader>
      <CardContent>
        {coursePlot ? (
          <>
            <pre className="text-xs bg-gray-900 p-2 rounded overflow-x-auto">
              {JSON.stringify(coursePlot)}
            </pre>
            <Button onClick={clearCoursePlot}>Clear course plot</Button>
          </>
        ) : (
          <pre>No active course plot</pre>
        )}
      </CardContent>
    </Card>
  );
};
