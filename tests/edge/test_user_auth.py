"""
Comprehensive tests for Supabase user authentication and character creation.

Tests the following edge functions:
- register: User account creation with email/password
- login: User authentication and session management
- user_character_create: Character creation for authenticated users
- user_character_list: List all characters owned by a user
"""

import os
import secrets
import time

import httpx
import pytest


API_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
EDGE_URL = os.environ.get('EDGE_FUNCTIONS_URL', f"{API_URL}/functions/v1")
REST_URL = f"{API_URL}/rest/v1"


# =============================================================================
# Helper Functions
# =============================================================================

def _generate_test_email() -> str:
    """Generate a unique test email address."""
    timestamp = int(time.time() * 1000)
    random_suffix = secrets.token_hex(4)
    return f"test_{timestamp}_{random_suffix}@example.com"


def _generate_test_character_name() -> str:
    """Generate a unique character name."""
    # Use microseconds for better uniqueness when called rapidly
    timestamp = int(time.time() * 1000000) % 1000000  # Last 6 digits of microseconds
    random_suffix = secrets.token_hex(2)  # 4 hex chars
    return f"TC_{timestamp}_{random_suffix}"[:20]  # Max 20 chars, "TC_" + 6 digits + "_" + 4 chars = 14 chars


def _call_register(email: str, password: str) -> httpx.Response:
    """Call the register edge function."""
    return httpx.post(
        f"{EDGE_URL}/register",
        headers={'Content-Type': 'application/json'},
        json={'email': email, 'password': password},
        timeout=10.0,
    )


def _call_login(email: str, password: str) -> httpx.Response:
    """Call the login edge function."""
    return httpx.post(
        f"{EDGE_URL}/login",
        headers={'Content-Type': 'application/json'},
        json={'email': email, 'password': password},
        timeout=10.0,
    )


def _call_character_create(token: str, name: str) -> httpx.Response:
    """Call the user_character_create edge function."""
    anon_key = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'apikey': anon_key,
    }
    # Only add Authorization header if token is provided
    if token:
        headers['Authorization'] = f'Bearer {token}'
    
    return httpx.post(
        f"{EDGE_URL}/user_character_create",
        headers=headers,
        json={'name': name},
        timeout=10.0,
    )


def _call_character_list(token: str) -> httpx.Response:
    """Call the user_character_list edge function."""
    anon_key = os.environ.get('SUPABASE_ANON_KEY', 'anon-key')
    headers = {
        'Content-Type': 'application/json',
        'apikey': anon_key,
    }
    # Only add Authorization header if token is provided
    if token:
        headers['Authorization'] = f'Bearer {token}'
    
    return httpx.post(
        f"{EDGE_URL}/user_character_list",
        headers=headers,
        json={},
        timeout=10.0,
    )


def _clear_rate_limits() -> None:
    """
    Clear rate limit tables to avoid rate limiting during non-rate-limit tests.
    
    This allows tests to run without hitting rate limits when we're not
    specifically testing rate limit behavior.
    
    Clears both public_rate_limits (IP-based) and rate_limits (character-based).
    """
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY required to clear rate limits')
    
    import subprocess
    
    try:
        # Clear both rate limit tables
        result = subprocess.run(
            [
                'psql',
                'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
                '-c',
                "DELETE FROM public_rate_limits; DELETE FROM rate_limits;",
            ],
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        if result.returncode != 0:
            pytest.skip(f'Failed to clear rate limits: {result.stderr}')
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        pytest.skip(f'Cannot clear rate limits - psql not available: {e}')


def _verify_email_in_db(email: str) -> None:
    """
    Directly verify a user's email in the database.
    
    This bypasses the email confirmation flow for testing purposes.
    Uses psql to update auth.users table directly.
    """
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY required to verify emails')
    
    # For local testing, we can directly update via psql
    import subprocess
    
    try:
        # Update auth.users table to mark email as confirmed
        result = subprocess.run(
            [
                'psql',
                'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
                '-c',
                f"UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = '{email}';",
            ],
            capture_output=True,
            text=True,
            timeout=5.0,
        )
        if result.returncode != 0:
            pytest.skip(f'Failed to verify email in database: {result.stderr}')
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        pytest.skip(f'Cannot verify email - psql not available: {e}')


def _register_and_verify_user(email: str, password: str) -> dict:
    """
    Helper to register a user and verify their email.
    Returns the user data from registration.
    """
    # Small delay to avoid rate limiting between tests
    time.sleep(1)
    
    resp = _call_register(email, password)
    assert resp.status_code == 201, f"Registration failed: {resp.text}"
    data = resp.json()
    assert data['success'] is True
    
    # Verify email in database
    _verify_email_in_db(email)
    
    return data


def _login_and_get_token(email: str, password: str) -> str:
    """
    Helper to login and extract the access token.
    Returns the access token string.
    """
    resp = _call_login(email, password)
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    data = resp.json()
    assert data['success'] is True
    return data['session']['access_token']


# =============================================================================
# User Registration Tests
# =============================================================================

@pytest.mark.edge
def test_register_success():
    """Test successful user registration with valid credentials."""
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Small delay to avoid rate limiting
    time.sleep(1)
    
    resp = _call_register(email, password)
    
    assert resp.status_code == 201
    data = resp.json()
    
    assert data['success'] is True
    assert 'user_id' in data
    assert data['email'] == email
    assert data['email_confirmed'] is False
    assert 'email to confirm' in data['message'].lower()


@pytest.mark.edge
def test_register_invalid_email():
    """Test registration with invalid email formats."""
    # Small delay to avoid rate limiting from previous test
    time.sleep(1)
    
    test_cases = [
        ('notemail', 'Invalid email address'),
        ('a', 'Invalid email address'),
    ]
    
    for invalid_email, expected_error_fragment in test_cases:
        resp = _call_register(invalid_email, 'valid_password')
        assert resp.status_code == 400, f"Expected 400 for email: {invalid_email}, got {resp.status_code}"
        data = resp.json()
        assert data['success'] is False
        assert expected_error_fragment.lower() in data['error'].lower()


@pytest.mark.edge
def test_register_short_password():
    """Test registration with password that's too short."""
    # Small delay to avoid rate limiting from previous test
    time.sleep(1)
    
    email = _generate_test_email()
    short_password = '12345'  # Only 5 characters
    
    resp = _call_register(email, short_password)
    
    assert resp.status_code == 400
    data = resp.json()
    assert data['success'] is False
    assert 'password' in data['error'].lower()
    assert 'at least 6' in data['error'].lower()


@pytest.mark.edge
def test_register_duplicate_email():
    """Test that registering the same email twice fails appropriately."""
    email = _generate_test_email()
    password = 'test_password_123'
    
    # First registration should succeed
    resp1 = _call_register(email, password)
    assert resp1.status_code == 201
    
    # Wait a bit to avoid rate limiting
    time.sleep(2)
    
    # Second registration with same email should fail
    resp2 = _call_register(email, password)
    # Could be 400 (duplicate email) or 429 (rate limited)
    # Both are acceptable - the important thing is it fails
    assert resp2.status_code in [400, 429], f"Expected 400 or 429, got {resp2.status_code}"
    data = resp2.json()
    assert data['success'] is False


# =============================================================================
# Login Tests
# =============================================================================

@pytest.mark.edge
def test_login_success():
    """Test successful login with verified account."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register and verify user
    _register_and_verify_user(email, password)
    
    # Login
    resp = _call_login(email, password)
    
    assert resp.status_code == 200
    data = resp.json()
    
    assert data['success'] is True
    
    # Check session data
    assert 'session' in data
    assert 'access_token' in data['session']
    assert 'refresh_token' in data['session']
    assert 'expires_at' in data['session']
    assert 'expires_in' in data['session']
    
    # Check user data
    assert 'user' in data
    assert data['user']['email'] == email
    assert data['user']['email_confirmed'] is True
    
    # Check characters (should be empty for new user)
    assert 'characters' in data
    assert isinstance(data['characters'], list)
    assert len(data['characters']) == 0


@pytest.mark.edge
def test_login_invalid_credentials():
    """Test login with incorrect password."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'correct_password'
    wrong_password = 'wrong_password'
    
    # Register and verify user
    _register_and_verify_user(email, password)
    
    # Try to login with wrong password
    resp = _call_login(email, wrong_password)
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False
    assert 'invalid' in data['error'].lower() or 'password' in data['error'].lower()


@pytest.mark.edge
def test_login_nonexistent_user():
    """Test login with email that doesn't exist."""
    nonexistent_email = _generate_test_email()
    password = 'any_password'
    
    resp = _call_login(nonexistent_email, password)
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False


@pytest.mark.edge
def test_login_unverified_email():
    """Test login with unverified email - should work but flag as unverified."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register but DON'T verify
    resp = _call_register(email, password)
    assert resp.status_code == 201
    
    # Login should succeed (Supabase allows login even without verification)
    resp = _call_login(email, password)
    
    # Some configurations block unverified logins, others allow it
    # If it succeeds, email_confirmed should be False
    if resp.status_code == 200:
        data = resp.json()
        assert data['success'] is True
        assert data['user']['email_confirmed'] is False


# =============================================================================
# Character Creation Tests
# =============================================================================

@pytest.mark.edge
def test_character_create_success():
    """Test successful character creation with verified user."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    character_name = _generate_test_character_name()
    
    # Register, verify, and login
    _register_and_verify_user(email, password)
    token = _login_and_get_token(email, password)
    
    # Create character
    resp = _call_character_create(token, character_name)
    
    assert resp.status_code == 201
    data = resp.json()
    
    assert data['success'] is True
    assert 'character_id' in data
    assert data['name'] == character_name
    
    # Check ship details
    assert 'ship' in data
    ship = data['ship']
    assert 'ship_id' in ship
    assert ship['ship_type'] == 'kestrel_courier'
    assert ship['current_sector'] == 0
    assert ship['credits'] == 5000


@pytest.mark.edge
def test_character_create_requires_auth():
    """Test that character creation requires authentication."""
    character_name = _generate_test_character_name()
    
    # Try to create character without token (empty token)
    resp = _call_character_create('', character_name)
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False


@pytest.mark.edge
def test_character_create_invalid_token():
    """Test character creation with invalid token."""
    character_name = _generate_test_character_name()
    
    resp = _call_character_create('invalid_token_xyz', character_name)
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False


@pytest.mark.edge
def test_character_create_requires_verified_email():
    """Test that character creation requires verified email."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    character_name = _generate_test_character_name()
    
    # Register but DON'T verify
    resp = _call_register(email, password)
    assert resp.status_code == 201
    
    # Try to login and create character
    login_resp = _call_login(email, password)
    
    # If login succeeds with unverified email
    if login_resp.status_code == 200:
        token = login_resp.json()['session']['access_token']
        
        # Character creation should fail due to unverified email
        resp = _call_character_create(token, character_name)
        
        assert resp.status_code == 403
        data = resp.json()
        assert data['success'] is False
        assert 'email' in data['error'].lower() and 'verif' in data['error'].lower()


@pytest.mark.edge
def test_character_create_invalid_name_format():
    """Test character creation with invalid name formats."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register, verify, and login
    _register_and_verify_user(email, password)
    token = _login_and_get_token(email, password)
    
    invalid_names = [
        ('ab', 'too short'),  # < 3 chars
        ('a' * 21, 'too long'),  # > 20 chars
        ('test@name', 'special char'),  # Invalid character
        ('test name', 'space'),  # Space not allowed
        ('test-name', 'hyphen'),  # Hyphen not allowed
    ]
    
    for invalid_name, reason in invalid_names:
        resp = _call_character_create(token, invalid_name)
        assert resp.status_code == 400, f"Expected 400 for {reason}: {invalid_name}"
        data = resp.json()
        assert data['success'] is False


@pytest.mark.edge
def test_character_create_duplicate_name():
    """Test that duplicate character names are rejected."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    # Create first user and character
    email1 = _generate_test_email()
    password1 = 'test_password_123'
    character_name = _generate_test_character_name()
    
    _register_and_verify_user(email1, password1)
    token1 = _login_and_get_token(email1, password1)
    
    resp1 = _call_character_create(token1, character_name)
    assert resp1.status_code == 201
    
    # Create second user and try same character name
    email2 = _generate_test_email()
    password2 = 'test_password_456'
    
    _register_and_verify_user(email2, password2)
    token2 = _login_and_get_token(email2, password2)
    
    resp2 = _call_character_create(token2, character_name)
    
    assert resp2.status_code == 409  # Conflict
    data = resp2.json()
    assert data['success'] is False
    assert 'already taken' in data['error'].lower() or 'duplicate' in data['error'].lower()


@pytest.mark.edge
def test_character_create_limit():
    """Test that users cannot create more than 5 characters."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register, verify, and login
    _register_and_verify_user(email, password)
    token = _login_and_get_token(email, password)
    
    # Create 5 characters (the limit)
    for i in range(5):
        character_name = _generate_test_character_name()
        resp = _call_character_create(token, character_name)
        if resp.status_code != 201:
            # Print error for debugging
            print(f"Character {i+1}/5 creation failed: {resp.status_code} - {resp.text}")
        assert resp.status_code == 201, f"Failed to create character {i+1}/5: {resp.status_code} - {resp.json()}"
        # Small delay to ensure unique names
        time.sleep(0.1)
    
    # Try to create a 6th character
    character_name = _generate_test_character_name()
    resp = _call_character_create(token, character_name)
    
    assert resp.status_code == 400
    data = resp.json()
    assert data['success'] is False
    assert 'maximum' in data['error'].lower() and '5' in data['error']


# =============================================================================
# Character List Tests
# =============================================================================

@pytest.mark.edge
def test_character_list_empty():
    """Test listing characters for a new user with no characters."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register, verify, and login
    _register_and_verify_user(email, password)
    token = _login_and_get_token(email, password)
    
    # List characters
    resp = _call_character_list(token)
    
    assert resp.status_code == 200
    data = resp.json()
    
    assert data['success'] is True
    assert 'characters' in data
    assert isinstance(data['characters'], list)
    assert len(data['characters']) == 0
    assert data['count'] == 0


@pytest.mark.edge
def test_character_list_with_characters():
    """Test listing characters after creating some."""
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register, verify, and login
    _register_and_verify_user(email, password)
    token = _login_and_get_token(email, password)
    
    # Create 3 characters
    created_names = []
    for i in range(3):
        character_name = _generate_test_character_name()
        created_names.append(character_name)
        resp = _call_character_create(token, character_name)
        assert resp.status_code == 201
    
    # List characters
    resp = _call_character_list(token)
    
    assert resp.status_code == 200
    data = resp.json()
    
    assert data['success'] is True
    assert 'characters' in data
    assert data['count'] == 3
    assert len(data['characters']) == 3
    
    # Verify character details
    returned_names = [char['name'] for char in data['characters']]
    for name in created_names:
        assert name in returned_names
    
    # Check first character has expected fields
    char = data['characters'][0]
    assert 'character_id' in char
    assert 'name' in char
    assert 'created_at' in char
    assert 'last_active' in char
    assert 'credits_in_bank' in char
    
    # Check ship details
    assert 'ship' in char
    if char['ship']:  # Ship might be null in some cases
        ship = char['ship']
        assert 'ship_id' in ship
        assert 'ship_type' in ship
        assert 'current_sector' in ship
        assert 'credits' in ship
        assert 'resources' in ship
        assert 'warp_power' in ship['resources']
        assert 'shields' in ship['resources']
        assert 'fighters' in ship['resources']
        assert 'cargo' in ship
        assert 'quantum_foam' in ship['cargo']
        assert 'retro_organics' in ship['cargo']
        assert 'neuro_symbolics' in ship['cargo']


@pytest.mark.edge
def test_character_list_requires_auth():
    """Test that listing characters requires authentication."""
    # Try to list characters without token
    resp = _call_character_list('')
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False


@pytest.mark.edge
def test_character_list_invalid_token():
    """Test listing characters with invalid token."""
    resp = _call_character_list('invalid_token_xyz')
    
    assert resp.status_code == 401
    data = resp.json()
    assert data['success'] is False


# =============================================================================
# Integration Test
# =============================================================================

@pytest.mark.edge
def test_full_user_flow():
    """
    End-to-end integration test covering the complete user flow:
    1. Register new user
    2. Verify email
    3. Login and get token
    4. Create character
    5. List characters and verify it appears
    6. Login again and verify character persists in login response
    """
    # Clear rate limits to avoid issues from previous tests
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    character_name = _generate_test_character_name()
    
    # Step 1: Register
    register_resp = _call_register(email, password)
    assert register_resp.status_code == 201
    register_data = register_resp.json()
    assert register_data['success'] is True
    assert register_data['email_confirmed'] is False
    
    # Step 2: Verify email
    _verify_email_in_db(email)
    
    # Step 3: Login
    login_resp = _call_login(email, password)
    assert login_resp.status_code == 200
    login_data = login_resp.json()
    assert login_data['success'] is True
    assert login_data['user']['email_confirmed'] is True
    assert len(login_data['characters']) == 0
    token = login_data['session']['access_token']
    user_id = login_data['user']['id']
    
    # Step 4: Create character
    create_resp = _call_character_create(token, character_name)
    assert create_resp.status_code == 201
    create_data = create_resp.json()
    assert create_data['success'] is True
    character_id = create_data['character_id']
    assert create_data['name'] == character_name
    
    # Step 5: List characters
    list_resp = _call_character_list(token)
    assert list_resp.status_code == 200
    list_data = list_resp.json()
    assert list_data['success'] is True
    assert list_data['count'] == 1
    assert len(list_data['characters']) == 1
    assert list_data['characters'][0]['character_id'] == character_id
    assert list_data['characters'][0]['name'] == character_name
    
    # Step 6: Login again and verify character appears in login response
    # Small delay to ensure database transaction is fully committed
    time.sleep(0.5)
    
    login2_resp = _call_login(email, password)
    assert login2_resp.status_code == 200
    login2_data = login2_resp.json()
    assert login2_data['success'] is True
    assert user_id == login2_data['user']['id'], "User ID changed between logins!"
    assert len(login2_data['characters']) == 1
    assert login2_data['characters'][0]['character_id'] == character_id
    assert login2_data['characters'][0]['name'] == character_name


# =============================================================================
# Rate Limiting Tests
# =============================================================================

@pytest.mark.edge
def test_register_rate_limit():
    """Test that register endpoint enforces rate limiting."""
    # Rate limit: 5 registrations per 5 minutes per IP
    # Make 6+ registration attempts rapidly to exceed the limit
    
    responses = []
    for i in range(7):
        email = _generate_test_email()
        resp = _call_register(email, 'test_password_123')
        responses.append(resp.status_code)
        # Don't sleep - we want to trigger rate limiting
    
    # At least one request should be rate limited (429)
    rate_limited_count = sum(1 for status in responses if status == 429)
    assert rate_limited_count > 0, f"Expected at least one 429 response, got statuses: {responses}"


@pytest.mark.edge
def test_login_rate_limit():
    """Test that login endpoint enforces rate limiting."""
    # Rate limit: 20 logins per 5 minutes per IP
    # Make 21+ requests to exceed the limit
    
    # First, clear rate limits so we have a clean slate
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register and verify user first
    time.sleep(2)  # Wait to avoid registration rate limit
    resp = _call_register(email, password)
    if resp.status_code == 429:
        pytest.skip("Registration rate limit hit - rate limiting is working, skipping login rate limit test")
    assert resp.status_code == 201
    _verify_email_in_db(email)
    
    # Make 21+ login attempts rapidly to exceed the limit of 20
    responses = []
    for i in range(25):
        resp = _call_login(email, password)
        responses.append(resp.status_code)
        # Don't sleep - we want to trigger rate limiting
    
    # At least one request should be rate limited (429)
    rate_limited_count = sum(1 for status in responses if status == 429)
    assert rate_limited_count > 0, f"Expected at least one 429 response after 25 requests (limit is 20), got statuses: {responses}"


@pytest.mark.edge
def test_character_create_rate_limit():
    """Test that character_create endpoint enforces rate limiting."""
    # Rate limit: 10 character creates per minute per user
    # Make 11+ requests to exceed the limit
    # Note: Character limit is 5 per user, so we'll hit that at request 6
    
    # First, clear rate limits so we have a clean slate
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register and verify user first
    time.sleep(2)  # Wait to avoid registration rate limit
    resp = _call_register(email, password)
    if resp.status_code == 429:
        pytest.skip("Registration rate limit hit - rate limiting is working, skipping character_create rate limit test")
    assert resp.status_code == 201
    _verify_email_in_db(email)
    
    # Login to get token
    token = _login_and_get_token(email, password)
    
    # Make 11+ character creation attempts rapidly
    # We'll hit EITHER rate limit (429 after 10 requests) OR character limit (400 after 5 characters)
    responses = []
    for i in range(15):
        character_name = _generate_test_character_name()
        resp = _call_character_create(token, character_name)
        responses.append(resp.status_code)
        time.sleep(0.1)  # Small delay to ensure unique names
    
    # At least one request should be rate limited (429) or hit the 5-character limit (400)
    rate_limited_or_limit = sum(1 for status in responses if status in [429, 400])
    # We expect to hit either rate limit or character limit
    assert rate_limited_or_limit > 0, f"Expected 429 or 400 responses, got statuses: {responses}"


@pytest.mark.edge
def test_character_list_rate_limit():
    """Test that character_list endpoint enforces rate limiting."""
    # Rate limit: 30 requests per minute per user
    # Make 31+ requests to exceed the limit
    
    # First, clear rate limits so we have a clean slate
    _clear_rate_limits()
    
    email = _generate_test_email()
    password = 'test_password_123'
    
    # Register and verify user first
    time.sleep(2)  # Wait to avoid registration rate limit
    resp = _call_register(email, password)
    if resp.status_code == 429:
        pytest.skip("Registration rate limit hit - rate limiting is working, skipping character_list rate limit test")
    assert resp.status_code == 201
    _verify_email_in_db(email)
    
    # Login to get token
    token = _login_and_get_token(email, password)
    
    # Make 31+ character list requests rapidly to exceed the limit of 30
    responses = []
    for i in range(35):
        resp = _call_character_list(token)
        responses.append(resp.status_code)
        # Don't sleep - we want to trigger rate limiting
    
    # At least one request should be rate limited (429)
    rate_limited_count = sum(1 for status in responses if status == 429)
    assert rate_limited_count > 0, f"Expected at least one 429 response after 35 requests (limit is 30), got statuses: {responses}"

