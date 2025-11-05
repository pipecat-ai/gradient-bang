import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/primitives/Card";

export const Error = ({
  children,
  onRetry,
}: {
  children: React.ReactNode;
  onRetry?: () => void;
}) => {
  return (
    <Card
      variant="stripes"
      className="h-screen stripe-frame-destructive-foreground bg-destructive/10"
      size="lg"
    >
      <CardHeader>
        <CardTitle className="text-5xl animate-pulse">
          Connection Error
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="normal-case">{children}</p>
      </CardContent>
      <CardContent className="mt-auto">
        <Button size="xl" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
};

export default Error;
