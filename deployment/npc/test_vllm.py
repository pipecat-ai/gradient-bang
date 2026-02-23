"""Quick smoke test for the deployed Nemotron vLLM service.

Usage:
    export LLM_SERVICE_URL=https://{org}--nemotron-nano-vllm-serve.modal.run
    uv run python test_vllm.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

MODEL_NAME = os.getenv("MODEL_NAME", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")


def main():
    base_url = os.environ.get("LLM_SERVICE_URL", "").rstrip("/")
    if not base_url:
        print("Error: set LLM_SERVICE_URL environment variable first.")
        print("  e.g. export LLM_SERVICE_URL=https://<org>--nemotron-nano-vllm-serve.modal.run")
        sys.exit(1)

    # --- Health check ---
    health_url = f"{base_url}/health"
    print(f"Health check: {health_url} ... ", end="", flush=True)
    try:
        req = urllib.request.Request(health_url)
        with urllib.request.urlopen(req, timeout=120) as resp:
            if resp.status == 200:
                print("OK")
            else:
                print(f"FAILED (status {resp.status})")
                sys.exit(1)
    except Exception as e:
        print(f"FAILED ({e})")
        sys.exit(1)

    # --- Completion request ---
    completions_url = f"{base_url}/v1/chat/completions"
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "system",
                "content": "You are a helpful assistant. Answer concisely in two to three sentences.",
            },
            {
                "role": "user",
                "content": "Where are the least rainy places in the United States?",
            },
        ],
        "max_tokens": 256,
        "chat_template_kwargs": {"enable_thinking": False},
    }

    data = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}

    print(f"\nSending completion request to {completions_url} ...")
    try:
        req = urllib.request.Request(completions_url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}")
        sys.exit(1)

    # --- Print result ---
    content = body["choices"][0]["message"]["content"]
    usage = body.get("usage", {})

    print(f"\nModel: {body.get('model', '?')}")
    print(
        f"Tokens: {usage.get('prompt_tokens', '?')} prompt, {usage.get('completion_tokens', '?')} completion"
    )
    print(f"\nResponse:\n{content}")


if __name__ == "__main__":
    main()
