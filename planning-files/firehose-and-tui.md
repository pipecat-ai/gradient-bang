# Firehose and TUI visualizers

Implement an /api/firehose WebSocket endpoint. When connected to this endpoint, a client receives a stream of all events in the game.

Send a message to the firehose each time a ship moves.

# Event stream viewer

Implement a terminal UI visualizer that connects to the firehose and streams events to the terminal.

# Character movement viewer

Implement a terminal UI that connects the firehose and show the movement of a specific character in a full-screen, ASCII view. Visualize the character's movement through the universe in the same connected-graph ASCII style as is used in tests/world-data/README.md.

Include a feature to list all characters sorted by when they were last seen. Allow the user to select which character to watch.

Display the character's stats and the stats of the current sector the character is in.

# Persistent map knowledge for each character

Implement persistent map knowledge for each character that survives reboots of the server.

As characters move through the universe, they learn what ports are in each sector and what goods are available for trade there. 

Create a data structure that stores sector connections and port information each character has seen, along with the last time they visited each sector. Save each character's data structure in a JSON file in a file named for the character's ID in a directory world-data/character-map-knowledge. Each time the character visits a sector, update the data structure and save it to the file.

Implement a /api/my-map endpoint that returns the map knowledge for a character.

Add this endpoint to the tools that are available to the LLM utilities. I want to be able to pass a task to run_npc.py that uses this endpoint.

For example:
  - "How many sectors have I visited?"
  - "Find a port close to me that sells organics."
  - "List all the port pairs that are in adjacent sectors, that I know about."

Add information about this endpoint to the TASK_EXECUTION_INSTRUCTIONS.
