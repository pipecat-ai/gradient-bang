# Game tools

## AsyncGameClient vs GameClient

We should only have one of these. Async operations are so important in almost all modern Python applications that we should standardize on AsyncGameClient.

Remove GameClient. Search for code that uses GameClient and replace it with AsyncGameClient. For example, I believe run_npc.py uses GameClient.

## Client logic for world knowledge "thinking"

The server should deliver the client the most recent map knowledge for each character, in response to the /api/my-map request. Beyond that minimal functionality, all world knowledge "thinking" should be done on the client side.

1. Implement the logic in /api/find-port and /api/port-pairs in the AsyncGameClient. I

2. Remove /api/find-port and /api/port-pairs endpoints from the server code.

3. Calling /api/my-map from run_npc.py does not work. Fix this. Update the run_npc.py code to be able to use the new AsyncGameClient find port and port pairs tools.

4. Test that the following command works as expected: 

```
uv run npc/run_npc.py tradery "Based on my world knowledge right now, what is the closes port to me that sells fuel ore?" 
```

