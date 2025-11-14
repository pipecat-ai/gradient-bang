from gradientbang.game_server.core.character_registry import CharacterRegistry, CharacterProfile


def test_character_registry_password_validation(tmp_path):
    registry_path = tmp_path / "characters.json"
    registry = CharacterRegistry(registry_path)
    registry.load()

    assert registry.admin_password_plain == ""
    assert registry.validate_admin_password(None)
    assert registry.validate_admin_password("")
    assert registry.validate_admin_password("anything")

    registry.set_admin_password("secret")
    assert registry.validate_admin_password("secret")
    assert not registry.validate_admin_password(None)
    assert not registry.validate_admin_password("wrong")


def test_character_registry_profile_crud(tmp_path):
    registry = CharacterRegistry(tmp_path / "characters.json")
    registry.load()
    registry.set_admin_password("secret")

    profile = CharacterProfile(character_id="uuid-123", name="Test Pilot")
    registry.add_or_update(profile)

    loaded = registry.get_profile("uuid-123")
    assert loaded is not None
    assert loaded.name == "Test Pilot"
    assert registry.name_exists("test pilot")

    registry.delete("uuid-123")
    assert registry.get_profile("uuid-123") is None
    assert not registry.name_exists("test pilot")
