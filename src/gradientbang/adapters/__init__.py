"""Pluggable adapters for cross-cutting client/server concerns.

Sibling subpackages live here for each adapter category. Today:
- ``events/`` — event-delivery transports for ``AsyncGameClient`` (polling, future pubsub).

Future categories (e.g. a pgmq-backed subagent bus) will sit alongside as new subpackages.
"""
