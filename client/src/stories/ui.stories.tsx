import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardScrollable,
  CardTitle,
} from "@/components/primitives/Card";
import { ScrollArea } from "@/components/primitives/ScrollArea";
import { Separator } from "@/components/primitives/Separator";
import { ScreenContainer } from "@/screens/ScreenContainer";
import { ScreenMenu } from "@/screens/ScreenMenu";
import Game from "@/views/Game";
import JoinStatus from "@/views/JoinStatus";
import ViewContainer from "@/views/ViewContainer";
import { AnimatedFrame } from "@fx/frame";
import type { Story } from "@ladle/react";
import { Dialog } from "radix-ui";
import React from "react";

export const DotStory: Story = () => (
  <div className="relative w-full h-screen">
    <div className="w-full h-full bg-dotted-sm bg-center">aa</div>
  </div>
);

DotStory.meta = {
  disconnectedStory: true,
};

export const ScreenUI: Story = () => (
  <div className="relative w-full h-screen flex flex-col items-center justify-center bg-slate-800">
    <ScreenMenu />
    <ScreenContainer />
    <AnimatedFrame />
  </div>
);

ScreenUI.meta = {
  disconnectedStory: true,
};

export const ScreenMenuUI: Story = () => (
  <div className="relative w-full h-screen">
    <ScreenMenu />
  </div>
);

ScreenMenuUI.meta = {
  disconnectedStory: true,
};

export const GameUI: Story = () => (
  <div className="relative w-full h-screen">
    <Game />
  </div>
);

GameUI.meta = {
  disconnectedStory: true,
};

export const ViewContainerUI: Story = () => (
  <div className="relative w-full h-screen">
    <ViewContainer />
  </div>
);

ViewContainerUI.meta = {
  disconnectedStory: true,
};

export const JoinStatusStory: Story = () => (
  <div className="relative w-full h-screen">
    <JoinStatus handleStart={() => {}} />
    <AnimatedFrame />
  </div>
);

JoinStatusStory.meta = {
  disconnectedStory: true,
};

const tags = Array.from({ length: 50 }).map(
  (_, i, a) => `v1.2.0-beta.${a.length - i}`
);

export const ScrollAreaDemo: Story = () => {
  return (
    <ScrollArea className="h-72 w-48 border">
      <div className="p-4">
        <h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>
        {tags.map((tag) => (
          <React.Fragment key={tag}>
            <div className="text-sm">{tag}</div>
            <Separator className="my-2" />
          </React.Fragment>
        ))}
      </div>
    </ScrollArea>
  );
};

ScrollAreaDemo.meta = {
  disconnectedStory: true,
};

export const ScrollableDialog: Story = () => {
  return (
    <Dialog.Root open={true} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay bg-gray-800/20 backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center animate-in fade-in-0 duration-300">
          <Dialog.Content className="DialogContent max-w-lg">
            <CardScrollable
              elbow={true}
              size="default"
              className="w-full h-full max-h-max bg-black/80 animate-in fade-in-0 zoom-in origin-center shadow-red-500"
            >
              <CardContent>
                <h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>
                {tags.map((tag) => (
                  <React.Fragment key={tag}>
                    <div className="text-sm">{tag}</div>
                    <Separator className="my-2" />
                  </React.Fragment>
                ))}
              </CardContent>
              <CardFooter>
                <Button onClick={() => {}} className="w-full">
                  Close
                </Button>
              </CardFooter>
            </CardScrollable>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

ScrollableDialog.meta = {
  disconnectedStory: true,
};

export const ScrollableFooterDialog: Story = () => {
  return (
    <Dialog.Root open={true} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay bg-gray-800/20 backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center animate-in fade-in-0 duration-300">
          <Dialog.Content className="DialogContent max-w-lg">
            <Card
              elbow={true}
              size="default"
              className="w-full h-full max-h-max bg-black/80 animate-in fade-in-0 zoom-in origin-center shadow-2xl"
            >
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <div className="flex-1 overflow-y-auto">
                <ScrollArea className="w-full h-full">
                  <CardContent>
                    <h4 className="mb-4 text-sm leading-none font-medium">
                      Tags
                    </h4>
                    {tags.map((tag) => (
                      <React.Fragment key={tag}>
                        <div className="text-sm">{tag}</div>
                        <Separator className="my-2" />
                      </React.Fragment>
                    ))}
                  </CardContent>
                </ScrollArea>
              </div>
              <CardFooter>
                <Button onClick={() => {}} className="w-full">
                  Close
                </Button>
              </CardFooter>
            </Card>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

ScrollableFooterDialog.meta = {
  disconnectedStory: true,
};
