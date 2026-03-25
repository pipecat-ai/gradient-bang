"""Decorator for marking agent methods as tools."""


def tool(fn=None, *, cancel_on_interruption=True):
    """Mark an agent method as a tool.

    On ``LLMAgent`` subclasses, decorated methods are automatically
    registered with the LLM via ``register_direct_function`` and
    included in ``build_tools()``.

    On ``FlowsAgent`` subclasses, decorated methods are automatically
    collected as global functions available at every flow node.

    Can be used with or without arguments::

        @tool
        async def my_tool(self, params, arg: str):
            ...

        @tool(cancel_on_interruption=False)
        async def my_tool(self, params, arg: str):
            ...

    Args:
        fn: The function to decorate (when used without arguments).
        cancel_on_interruption: Whether to cancel this tool call when
            an interruption occurs. Defaults to True. Only applies to
            ``LLMAgent`` tools.
    """

    def decorator(fn):
        fn.is_agent_tool = True
        fn.cancel_on_interruption = cancel_on_interruption
        return fn

    if fn is not None:
        return decorator(fn)
    return decorator


def _collect_tools(obj) -> list:
    """Collect all ``@tool`` decorated bound methods from an object.

    Walks the MRO so that overridden methods in subclasses take
    precedence over base-class definitions.
    """
    seen: set[str] = set()
    tools = []
    for cls in type(obj).__mro__:
        for name, val in cls.__dict__.items():
            if name in seen:
                continue
            seen.add(name)
            if callable(val) and getattr(val, "is_agent_tool", False):
                tools.append(getattr(obj, name))
    return tools
