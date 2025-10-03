import { CardContent, CardHeader, CardTitle } from "@pipecat-ai/voice-ui-kit";

export const StartScreen = ({ children }: { children: React.ReactNode }) => {
  return (
    <>
      <CardHeader>
        <CardTitle className="text-2xl">Gradiant Bang</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Welcome message goes here</p>
      </CardContent>
      <CardContent className="flex flex-col gap-4 mt-auto">
        {children}
      </CardContent>
    </>
  );
};
