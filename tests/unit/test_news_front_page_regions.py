from __future__ import annotations

import json

from gradientbang.newspaper.scripts.front_page_regions import (
    build_region_prompt,
    build_units,
    choose_generation_size,
    default_references,
    parse_front_page_markdown,
    plan_regions,
    read_layout,
    references_for_unit,
)


def write_front_page(path):
    path.write_text(
        '# THE GRADIENT NEWS & OBSERVER\n\n'
        '**Front-Page Edition -- Test Window**\n\n'
        '*"All the news the void allows."*\n\n'
        '---\n\n'
        '## 1. Exact Lead Headline\n\n'
        '*Straight News*\n\n'
        'Lead paragraph with $1,234 and PlayerName.\n\n'
        'Second paragraph remains exact.\n\n'
        '---\n\n'
        '## 2. Second Headline\n\n'
        '*Straight News*\n\n'
        'Second story body.\n\n'
        '---\n\n'
        '## 3. Third Headline\n\n'
        '*Straight News*\n\n'
        'Third body.\n\n'
        '---\n\n'
        '## 4. Fourth Headline\n\n'
        '*Straight News*\n\n'
        'Fourth body.\n\n'
        '---\n\n'
        '## 5. Fifth Headline\n\n'
        '*Straight News*\n\n'
        'Fifth body.\n\n'
        '---\n\n'
        '## 6. Sixth Headline\n\n'
        '*Straight News*\n\n'
        'Sixth body.\n\n'
        '---\n\n'
        '## 7. Seventh Headline\n\n'
        '*Straight News*\n\n'
        'Seventh body.\n\n'
        '---\n\n'
        '## 8. Eighth Headline\n\n'
        '*Gossip Column*\n\n'
        'Eighth body.\n\n'
        '---\n\n'
        '## 9. Ninth Headline\n\n'
        '*Gossip Column*\n\n'
        'Ninth body.\n\n'
        '---\n\n'
        '## 10. Market Update\n\n'
        '*Market Update Box*\n\n'
        '| Measure | Value |\n'
        '| --- | ---: |\n'
        '| Gross trade volume | $9,999 |\n\n'
        '*Footnote text.*\n',
        encoding='utf-8',
    )


def write_layout(path):
    path.write_text(
        json.dumps(
            {
                "source_size": {"width": 1024, "height": 1536},
                "source_image": "reference.png",
                "regions": [
                    {"id": "masthead", "bbox": [12, 11, 1013, 155]},
                    {"id": "edition_strip", "bbox": [12, 166, 1012, 199]},
                    {"id": "story_01", "bbox": [12, 209, 567, 714]},
                    {"id": "story_02", "bbox": [578, 209, 1013, 714]},
                    {"id": "story_03", "bbox": [12, 727, 213, 1149]},
                    {"id": "story_04", "bbox": [222, 727, 409, 1149]},
                    {"id": "story_05", "bbox": [418, 727, 603, 1149]},
                    {"id": "story_06", "bbox": [613, 727, 799, 1149]},
                    {"id": "story_07", "bbox": [808, 727, 1012, 1149]},
                    {"id": "story_10", "bbox": [12, 1161, 508, 1477]},
                    {"id": "gossip_panel", "bbox": [518, 1161, 1012, 1477]},
                    {
                        "id": "story_08",
                        "bbox": [721, 1207, 987, 1322],
                        "parent": "gossip_panel",
                    },
                    {
                        "id": "story_09",
                        "bbox": [721, 1348, 987, 1459],
                        "parent": "gossip_panel",
                    },
                    {"id": "footer", "bbox": [316, 1485, 710, 1516]},
                ],
            }
        ),
        encoding="utf-8",
    )


def test_parse_front_page_markdown_extracts_exact_copy(tmp_path):
    front_page_md = tmp_path / "front-page.md"
    write_front_page(front_page_md)

    parsed = parse_front_page_markdown(front_page_md)

    assert parsed.title == "THE GRADIENT NEWS & OBSERVER"
    assert parsed.edition_line == "Front-Page Edition -- Test Window"
    assert parsed.motto == "All the news the void allows."
    assert parsed.stories[1].headline == "Exact Lead Headline"
    assert "Lead paragraph with $1,234 and PlayerName." in parsed.stories[1].render_text
    assert "Gross trade volume | $9,999" in parsed.stories[10].render_text
    assert "| ---" not in parsed.stories[10].render_text
    assert "Footnote text." in parsed.stories[10].render_text


def test_choose_generation_size_satisfies_gpt_image_2_constraints():
    for target in [(2284, 429), (458, 963), (899, 71), (1132, 721)]:
        width, height = choose_generation_size(*target)

        assert width % 16 == 0
        assert height % 16 == 0
        assert max(width, height) <= 3840
        assert max(width, height) / min(width, height) <= 3
        assert 655_360 <= width * height <= 8_294_400


def test_build_units_splits_gossip_panel_into_story_08_and_story_09(tmp_path):
    layout_path = tmp_path / "layout.json"
    write_layout(layout_path)

    units = build_units(read_layout(layout_path))

    assert [unit.id for unit in units] == [
        "header",
        "story_01",
        "story_02",
        "story_03",
        "story_04",
        "story_05",
        "story_06",
        "story_07",
        "story_08",
        "story_09",
        "story_10",
        "footer",
    ]
    assert units[0].bbox == (12, 11, 1013, 199)
    assert units[8].id == "story_08"
    assert units[8].bbox == (518, 1161, 760, 1477)
    assert units[8].story_numbers == (8,)
    assert units[9].id == "story_09"
    assert units[9].bbox == (770, 1161, 1012, 1477)
    assert units[9].story_numbers == (9,)


def test_region_prompt_contains_only_selected_story_copy(tmp_path):
    front_page_md = tmp_path / "front-page.md"
    layout_path = tmp_path / "layout.json"
    write_front_page(front_page_md)
    write_layout(layout_path)
    front_page = parse_front_page_markdown(front_page_md)
    layout = read_layout(layout_path)
    unit = [unit for unit in build_units(layout) if unit.id == "story_01"][0]

    prompt = build_region_prompt(
        front_page=front_page,
        unit=unit,
        source_size=(1024, 1536),
        target_bbox=(27, 477, 1294, 1629),
        generation_size=(1264, 1152),
        references=(),
    )

    assert "Exact Lead Headline" in prompt
    assert "Lead paragraph with $1,234 and PlayerName." in prompt
    assert "Second Headline" not in prompt
    assert "Do not render Markdown syntax" in prompt
    assert "Every story-region headline" in prompt
    assert "bold condensed rectilinear terminal-display face" in prompt
    assert "Do not use serif, slab-serif, ornate Victorian" in prompt
    assert "HEADLINE = bright luminous chartreuse-green ink around #B7F23A, never cyan" in prompt
    assert "Avoid mustard, amber, olive, brown, gold, dim yellow" in prompt
    assert "Only the header region may render a newspaper masthead" in prompt
    assert "Geek Club" not in prompt


def test_gossip_story_prompts_are_independent(tmp_path):
    front_page_md = tmp_path / "front-page.md"
    layout_path = tmp_path / "layout.json"
    write_front_page(front_page_md)
    write_layout(layout_path)
    front_page = parse_front_page_markdown(front_page_md)
    layout = read_layout(layout_path)
    story_08 = [unit for unit in build_units(layout) if unit.id == "story_08"][0]
    story_09 = [unit for unit in build_units(layout) if unit.id == "story_09"][0]

    story_08_prompt = build_region_prompt(
        front_page=front_page,
        unit=story_08,
        source_size=(1024, 1536),
        target_bbox=(1182, 2651, 1734, 3372),
        generation_size=(656, 848),
        references=(),
    )
    story_09_prompt = build_region_prompt(
        front_page=front_page,
        unit=story_09,
        source_size=(1024, 1536),
        target_bbox=(1756, 2651, 2308, 3372),
        generation_size=(656, 848),
        references=(),
    )

    assert "Eighth Headline" in story_08_prompt
    assert "Ninth Headline" not in story_08_prompt
    assert "Gossip Column" in story_08_prompt
    assert "Shared section label" not in story_08_prompt
    assert "Ninth Headline" in story_09_prompt
    assert "Eighth Headline" not in story_09_prompt


def test_market_prompt_forbids_masthead_text(tmp_path):
    front_page_md = tmp_path / "front-page.md"
    layout_path = tmp_path / "layout.json"
    write_front_page(front_page_md)
    write_layout(layout_path)
    front_page = parse_front_page_markdown(front_page_md)
    layout = read_layout(layout_path)
    unit = [unit for unit in build_units(layout) if unit.id == "story_10"][0]

    prompt = build_region_prompt(
        front_page=front_page,
        unit=unit,
        source_size=(1024, 1536),
        target_bbox=(27, 2651, 1160, 3372),
        generation_size=(1136, 720),
        references=(),
    )

    assert "Market Update" in prompt
    assert "Forbidden text for this market region: THE GRADIENT NEWS & OBSERVER" in prompt
    assert "This region is a market statistics box only" in prompt


def test_default_references_do_not_include_external_geek_club_image():
    refs = default_references()

    assert refs
    assert all("geek-club" not in str(path) for path in refs)
    assert any("newspaper/assets/references" in str(path) for path in refs)


def test_masthead_reference_is_header_only(tmp_path):
    layout_path = tmp_path / "layout.json"
    write_layout(layout_path)
    units = {unit.id: unit for unit in build_units(read_layout(layout_path))}
    refs = default_references()

    header_refs = references_for_unit(units["header"], refs)
    story_refs = references_for_unit(units["story_01"], refs)

    assert any("masthead-style" in str(path) for path in header_refs)
    assert all("masthead-style" not in str(path) for path in story_refs)


def test_plan_regions_writes_prompt_and_uses_selected_region(tmp_path):
    front_page_md = tmp_path / "front-page.md"
    layout_path = tmp_path / "layout.json"
    write_front_page(front_page_md)
    write_layout(layout_path)

    planned, hashes = plan_regions(
        front_page=parse_front_page_markdown(front_page_md),
        layout=read_layout(layout_path),
        front_page_md=front_page_md,
        out_dir=tmp_path / "out",
        composite_size=(2336, 3504),
        global_references=[],
        model="gpt-image-2",
        quality="high",
        selected_regions={"story_01"},
        force=False,
        dry_run=True,
    )

    assert len(planned) == 1
    assert planned[0].unit.id == "story_01"
    assert planned[0].prompt.exists()
    assert hashes["story_01"]
    assert "--dry-run" in planned[0].command
