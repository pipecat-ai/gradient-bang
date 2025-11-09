import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardScrollable,
  CardTitle,
} from "@/components/primitives/Card";
import { Progress } from "@/components/primitives/Progress";
import { ScrollArea } from "@/components/primitives/ScrollArea";
import { Separator } from "@/components/primitives/Separator";
import { ScreenContainer } from "@/components/screens/ScreenContainer";
import { ScreenMenu } from "@/components/screens/ScreenMenu";
import Error from "@/components/views/Error";
import Game from "@/components/views/Game";
import JoinStatus from "@/components/views/JoinStatus";
import ViewContainer from "@/components/views/ViewContainer";
import { AnimatedFrame } from "@fx/frame";
import type { Story } from "@ladle/react";
import { Dialog } from "radix-ui";
import React, { useState } from "react";

export const DotStory: Story = () => (
  <div className="relative w-full h-screen">
    <div className="w-full h-full bg-dotted-sm bg-center">DOTS</div>
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
    <AnimatedFrame />
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

export const CardStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Card variant="stripes">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" className="stripe-frame-destructive">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" size="lg">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" className="stripe-frame-blue-500/20">
      <CardContent>Hello</CardContent>
    </Card>

    <Card
      variant="stripes"
      className="stripe-frame-white/50 border border-white bg-white/10 stripe-frame-ui-sm"
    >
      <CardContent>Custom stripe size override</CardContent>
    </Card>
  </div>
);

CardStory.meta = {
  disconnectedStory: true,
};

export const ErrorCardStory: Story = () => <Error>Connection Error</Error>;

ErrorCardStory.meta = {
  disconnectedStory: true,
};

export const ButtonStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Button>Primary</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="ghost">Ghost</Button>

    <Button size="sm">Small</Button>
    <Button size="lg">Large</Button>
    <Button size="xl">XLarge</Button>
  </div>
);

ButtonStory.meta = {
  disconnectedStory: true,
};

export const BadgeStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Badge>
      Badge <span>0</span>
    </Badge>
    <div className="flex flex-row gap-4">
      <Badge border="elbow" size="sm">
        Badge
      </Badge>
      <Badge border="elbow">Badge</Badge>
      <Badge border="elbow" size="lg">
        Badge
      </Badge>
    </div>
    <div className="flex flex-row gap-4">
      <Badge border="bracket" size="sm">
        Badge
      </Badge>
      <Badge border="bracket">Badge</Badge>
      <Badge border="bracket" size="lg">
        Badge
      </Badge>
      <Badge border="bracket" size="lg" className="elbow">
        Badge
      </Badge>
    </div>

    <Badge border="none">
      Warp: <Progress value={50} color="fuel" />
    </Badge>
  </div>
);

BadgeStory.meta = {
  disconnectedStory: true,
};

export const ProgressStory: Story = () => {
  const [progress, setProgress] = useState(0);

  const incrementCx =
    "bg-green-800 stripe-bar stripe-bar-green-500 stripe-bar-20 stripe-bar-animate-1";
  const decrementCx =
    "bg-red-900 stripe-bar stripe-bar-red-500 stripe-bar-20 stripe-bar-animate-1 stripe-bar-reverse";

  return (
    <div className="flex flex-col gap-4">
      <Progress value={progress} color="fuel" className="h-[80px]" />
      <Separator />
      <Progress
        value={progress}
        color="fuel"
        className="h-[80px] "
        classNames={{
          increment: incrementCx,
          decrement: decrementCx,
        }}
        segmented={true}
      />
      <Separator />
      <Button onClick={() => setProgress(progress + 10)}>Increment</Button>
      <Button onClick={() => setProgress(progress - 10)}>Decrement</Button>
    </div>
  );
};

ProgressStory.meta = {
  disconnectedStory: true,
};
