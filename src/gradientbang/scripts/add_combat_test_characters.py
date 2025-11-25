#!/usr/bin/env python3
"""Add character creation calls to combat tests that need them."""

import re
from pathlib import Path

# The test file
TEST_FILE = Path("tests/integration/test_combat_system.py")

# Read the file
content = TEST_FILE.read_text()

# Find all test functions and extract character IDs from AsyncGameClient calls
test_pattern = re.compile(
    r'(    async def (test_\w+)\(self, test_server\):.*?)((?=\n    async def test_)|(?=\n\nclass )|(?=\Z))',
    re.DOTALL
)

# Pattern to find character_id in AsyncGameClient
char_pattern = re.compile(r'character_id="([^"]+)"')

# Tests that already have character creation
ALREADY_FIXED = {"test_two_players_combat_attack_actions"}

modifications = []
new_content = content

for match in test_pattern.finditer(content):
    test_body = match.group(1)
    test_name = match.group(2)

    if test_name in ALREADY_FIXED:
        continue

    # Extract all character IDs used in this test
    char_ids = char_pattern.findall(test_body)
    # Remove special ones like test_reset_client
    char_ids = [cid for cid in char_ids if cid != "test_reset_client"]
    # Get unique, preserve order
    seen = set()
    unique_chars = []
    for cid in char_ids:
        if cid not in seen:
            seen.add(cid)
            unique_chars.append(cid)

    if not unique_chars:
        continue

    # Find the docstring end
    docstring_match = re.search(r'async def ' + test_name + r'\(self, test_server\):\s*""".*?"""', test_body, re.DOTALL)
    if not docstring_match:
        print(f"Warning: No docstring found in {test_name}")
        continue

    # Check if character creation already exists
    if 'create_test_character_knowledge(' in test_body[:500]:
        print(f"Skipping {test_name} - already has character creation")
        continue

    # Generate creation calls with comment
    creation_block = "\n        # Create test characters before initializing clients\n"
    creation_block += "\n".join(
        f'        create_test_character_knowledge("{cid}", sector=0)'
        for cid in unique_chars
    )
    creation_block += "\n"

    # Find where to insert (right after docstring)
    insertion_point = test_body.find('"""', test_body.find('"""') + 3) + 3

    # Build the modified test
    old_test = test_body
    new_test = test_body[:insertion_point] + creation_block + test_body[insertion_point:]

    # Replace in content
    new_content = new_content.replace(old_test, new_test, 1)

    modifications.append({
        'test_name': test_name,
        'char_ids': unique_chars,
    })

    print(f"✓ {test_name}: {len(unique_chars)} characters - {', '.join(unique_chars)}")

if modifications:
    # Write back
    TEST_FILE.write_text(new_content)
    print(f"\n✅ Modified {len(modifications)} tests")
    print(f"Total unique character IDs added: {len(set(cid for m in modifications for cid in m['char_ids']))}")
else:
    print("\nNo modifications needed - all tests already have character creation")
