import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@pipecat-ai/voice-ui-kit";

export const Error = ({
  children,
  onRetry,
}: {
  children: React.ReactNode;
  onRetry?: () => void;
}) => {
  return (
    <Card
      background="stripes"
      variant="destructive"
      className="h-screen"
      size="lg"
    >
      <CardHeader>
        <CardTitle className="text-4xl animate-pulse">
          Connection Error
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="normal-case">{children}</p>
      </CardContent>
      <CardContent className="mt-auto">
        <Button onClick={onRetry}>Try again</Button>
      </CardContent>
    </Card>
  );
};

export default Error;
