import { PipecatClient } from "@pipecat-ai/client-js";

/**
 * Send user text input to the bot via RTVI message
 * @param text - The text to send to the bot
 */
export function sendUserTextInput(text: string): void {
  // Get the client from the global window object (we'll set this in main.tsx)
  const client = (window as any).__pipecatClient as PipecatClient | undefined;

  if (!client) {
    console.error("[ConsoleAPI] PipecatClient not available. Are you connected?");
    return;
  }

  if (client.state !== "ready") {
    console.error(`[ConsoleAPI] Client not ready. Current state: ${client.state}`);
    return;
  }

  console.log(`[ConsoleAPI] Sending user text input: "${text}"`);

  // Send the message with action type "user-text-input"
  client.sendClientMessage("user-text-input", { text });

  console.log("[ConsoleAPI] Message sent successfully");
}

// Expose the function globally for console access
if (typeof window !== 'undefined') {
  (window as any).sendUserTextInput = sendUserTextInput;
  console.log('[ConsoleAPI] sendUserTextInput() function is now available in the console');
}
