# Plan for initial test LLM OODA loop.

We want to build a simple POC of an NPC that can execute strategies based on natural language. We'll use an LLM for this.

## Architecture.

The NPC operates an OODA loop for as many turns as necessary to complete a task.

Observe -> Orient -> Decide -> Act

Observe - Request updates from the game server.
Orient - Create a new prompt to send to the LLM.
Decide - Run LLM inference.
Act - Run any tool calls from the LLM response. 

## State

The NPC has a state that is updated after each OODA loop iteration.

- Current sector
- Current time

## Tools

The LLM has access to the following tools:

- PlotCourse - Calls the /api/plot-course endpoint.
- WaitForTime - Pauses the NPC for the specified number of seconds.
- Move - Calls the /api/move endpoint.
- MyStatus - Calls the /api/my-status endpoint
- Finished - Ends the current task loop

## Implementation

Let's start with a simple command-line interface to the NPC. The command-line script takes two arguments, the character ID and a natural-language task for the NPC to execute.

When the command-line script starts, it manually calls the /api/join endpoint to set up the character on the server and to get the current state.

The script then enters the OODA loop.

## Prompting

The prompt for the LLM consists of three sections.

1. Description of the game, rules, and available tools.
2. Instructions for the LLM on how to execute the task. First plan. Take one step at a time. If you need to use any tools, use the tools. Execute an individual step and return any interim results relevant to the next inference call.
3. The task to be completed.
4. All previous observations and decisions, plus the most recent game state.

Each time through the OODA loop, section 4 is updated with the output of the last LLM inference call, plus a fetch of the current game state.

## Development

Implement this command-line interface in Python.

Write an expanded version of the prompt sections 1 and 2 described above. Use the best available LLM prompting techniques to create a detailed and clear prompt that will guide the LLM to execute complex tasks one step at a time for each invocation of this loop. Give an example of moving from one sector to another by making several tool calls and moving only one sector per loop iteration. Emphasize that it is important to take one step at a time, so the world state can be observed each step. In the example of moving across multiple sectors, it is important to be able to react to what is in each sector, each time the ship warps into a new sector.

Use the openai Python client and the `responses` API to interface with the LLM. Use the "gpt-4-turbo-preview" model (or "gpt-4o" for faster responses).

Print out all LLM activity to the console.

Exit the program when the LLM calls the `Finished` tool.
