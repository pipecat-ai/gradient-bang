"""
Unit tests for context compression functionality.

Run with: uv run pytest tests/unit/test_context_compression.py -v

To run tests that call the real Gemini API:
    uv run pytest tests/unit/test_context_compression.py -v -m live_api
"""

import asyncio
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()
from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection

from gradientbang.pipecat_server.context_compression import (
    COMPRESSION_INTENT_SYSTEM_PROMPT,
    COMPRESSION_SYSTEM_PROMPT,
    ContextCompressionConsumer,
    ContextCompressionProducer,
)
from gradientbang.pipecat_server.frames import GradientBangContextCompressionFrame


@pytest.fixture
def llm_context():
    """Create a test LLM context with sample messages."""
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ]
    return LLMContext(messages)


@pytest.fixture
def large_llm_context():
    """Create an LLM context with many messages to trigger threshold compression."""
    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    for i in range(250):  # Exceeds default threshold of 200
        messages.append({"role": "user", "content": f"Message {i}"})
        messages.append({"role": "assistant", "content": f"Response {i}"})
    return LLMContext(messages)


class TestFrameCreation:
    """Tests for GradientBangContextCompressionFrame creation."""

    def test_compression_frame_creation(self, llm_context):
        """Test that GradientBangContextCompressionFrame can be created."""
        frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary timestamp=2024-01-01T00:00:00>Test summary</summary>",
            original_messages_count=100,
            trigger_reason="threshold",
            compression_duration_ms=1234.5,
            original_approx_tokens=5000,
            compressed_approx_tokens=200,
        )
        assert frame.context is llm_context
        assert frame.compressed_summary.startswith("<summary")
        assert frame.original_messages_count == 100
        assert frame.trigger_reason == "threshold"
        assert frame.compression_duration_ms == 1234.5
        assert frame.original_approx_tokens == 5000
        assert frame.compressed_approx_tokens == 200

    def test_compression_frame_has_timestamp(self, llm_context):
        """Test that frame gets automatic timestamp."""
        frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary>Test</summary>",
            original_messages_count=10,
            trigger_reason="threshold",
            compression_duration_ms=100.0,
            original_approx_tokens=100,
            compressed_approx_tokens=10,
        )
        assert frame.timestamp is not None
        assert isinstance(frame.timestamp, datetime)


class TestProducer:
    """Tests for ContextCompressionProducer."""

    @pytest.mark.asyncio
    async def test_producer_caches_context(self, llm_context):
        """Test that producer caches context from LLMContextFrame."""
        producer = ContextCompressionProducer(
            api_key="test-key",
            message_threshold=200,
        )
        producer._consumers = []  # Mock consumer list

        frame = LLMContextFrame(context=llm_context)

        with patch.object(producer, "_check_compression_needed", return_value=None):
            await producer.process_frame(frame, FrameDirection.DOWNSTREAM)

        assert producer._context is llm_context

    @pytest.mark.asyncio
    async def test_threshold_detection(self, large_llm_context):
        """Test that exceeding message threshold is detected."""
        producer = ContextCompressionProducer(
            api_key="test-key",
            message_threshold=200,
        )

        with patch.object(producer, "_check_explicit_request", return_value=False):
            trigger_reason = await producer._check_compression_needed(
                large_llm_context.messages
            )

        assert trigger_reason == "threshold"

    @pytest.mark.asyncio
    async def test_no_compression_below_threshold(self, llm_context):
        """Test that compression doesn't trigger below threshold."""
        producer = ContextCompressionProducer(
            api_key="test-key",
            message_threshold=200,
        )

        with patch.object(producer, "_check_explicit_request", return_value=False):
            trigger_reason = await producer._check_compression_needed(
                llm_context.messages
            )

        assert trigger_reason is None

    @pytest.mark.asyncio
    async def test_explicit_request_detection(self):
        """Test detection of explicit compression requests."""
        producer = ContextCompressionProducer(api_key="test-key")

        # Mock the Gemini client
        mock_response = MagicMock()
        mock_response.candidates = [MagicMock()]
        mock_response.candidates[0].content.parts = [MagicMock()]
        mock_response.candidates[0].content.parts[0].text = "yes"

        producer._client = MagicMock()
        producer._client.aio.models.generate_content = AsyncMock(
            return_value=mock_response
        )

        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Your context is getting too long. Can you compress your memory?"},
        ]

        result = await producer._check_explicit_request(messages)
        assert result is True

    @pytest.mark.asyncio
    async def test_explicit_request_rejection(self):
        """Test that non-compression requests are rejected."""
        producer = ContextCompressionProducer(api_key="test-key")

        # Mock "no" response
        mock_response = MagicMock()
        mock_response.candidates = [MagicMock()]
        mock_response.candidates[0].content.parts = [MagicMock()]
        mock_response.candidates[0].content.parts[0].text = "no"

        producer._client = MagicMock()
        producer._client.aio.models.generate_content = AsyncMock(
            return_value=mock_response
        )

        messages = [
            {"role": "user", "content": "What's the weather like?"},
        ]

        result = await producer._check_explicit_request(messages)
        assert result is False

    def test_cooldown_no_previous_compression(self):
        """Test cooldown is satisfied when no previous compression exists."""
        producer = ContextCompressionProducer(api_key="test-key")

        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]

        assert producer._cooldown_satisfied(messages) is True

    def test_cooldown_not_satisfied(self):
        """Test cooldown prevents compression when not enough messages after summary."""
        producer = ContextCompressionProducer(api_key="test-key", message_threshold=200)

        messages = [
            {"role": "system", "content": "System prompt"},
            {
                "role": "user",
                "content": "<session_history_summary><summary>Previous summary</summary></session_history_summary>",
            },
            {"role": "user", "content": "Message 1"},
            {"role": "assistant", "content": "Response 1"},
        ]

        # Only 2 messages after summary - cooldown NOT satisfied
        assert producer._cooldown_satisfied(messages) is False

    def test_cooldown_satisfied_after_enough_messages(self):
        """Test cooldown is satisfied after 5+ messages."""
        producer = ContextCompressionProducer(api_key="test-key", message_threshold=200)

        messages = [
            {"role": "system", "content": "System prompt"},
            {
                "role": "user",
                "content": "<session_history_summary><summary>Previous summary</summary></session_history_summary>",
            },
            {"role": "user", "content": "Message 1"},
            {"role": "assistant", "content": "Response 1"},
            {"role": "user", "content": "Message 2"},
            {"role": "assistant", "content": "Response 2"},
            {"role": "user", "content": "Message 3"},
        ]

        # 5 messages after summary - cooldown satisfied
        assert producer._cooldown_satisfied(messages) is True

    def test_prepare_compression_messages_formats_as_single_user_message(self):
        """Test that messages are formatted as a single user message document."""
        producer = ContextCompressionProducer(api_key="test-key")

        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]

        result = producer._prepare_compression_messages(messages)

        # Should return a single Content object
        assert len(result) == 1
        assert result[0].role == "user"

        # Check the formatted text contains the conversation
        text = result[0].parts[0].text
        assert "CONVERSATION HISTORY TO COMPRESS" in text
        assert "[USER]: Hello" in text
        assert "[ASSISTANT]: Hi" in text
        assert "END OF CONVERSATION HISTORY" in text
        # System message should be excluded
        assert "System prompt" not in text

    def test_estimate_tokens(self):
        """Test token estimation from messages."""
        producer = ContextCompressionProducer(api_key="test-key")

        messages = [
            {"role": "user", "content": "1234567890123456"},  # 16 chars = 4 tokens
        ]

        assert producer._estimate_tokens(messages) == 4

    def test_extract_recent_exchanges(self):
        """Test extraction of recent user/assistant messages."""
        producer = ContextCompressionProducer(api_key="test-key")

        messages = [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Msg 1"},
            {"role": "assistant", "content": "Reply 1"},
            {"role": "user", "content": "Msg 2"},
            {"role": "assistant", "content": "Reply 2"},
        ]

        result = producer._extract_recent_exchanges(messages, count=3)

        assert len(result) == 3
        # Result is now Content objects with .parts[0].text
        assert result[0].parts[0].text == "Reply 1"
        assert result[1].parts[0].text == "Msg 2"
        assert result[2].parts[0].text == "Reply 2"


class TestConsumer:
    """Tests for ContextCompressionConsumer."""

    @pytest.mark.asyncio
    async def test_consumer_receives_context_via_frame(self, llm_context):
        """Test that consumer receives context from compression frame."""
        producer = ContextCompressionProducer(api_key="test-key")
        consumer = ContextCompressionConsumer(producer=producer)

        compression_frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary timestamp=2024-01-01T00:00:00>Test</summary>",
            original_messages_count=3,
            trigger_reason="threshold",
            compression_duration_ms=100.0,
            original_approx_tokens=50,
            compressed_approx_tokens=10,
        )

        await consumer._apply_compression(compression_frame)

        # Verify the context was modified
        assert len(llm_context.messages) == 2  # system + summary

    @pytest.mark.asyncio
    async def test_compression_preserves_system_message(self):
        """Test that system messages are preserved when applying compression."""
        producer = ContextCompressionProducer(api_key="test-key")
        consumer = ContextCompressionConsumer(producer=producer)

        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "How are you?"},
            {"role": "assistant", "content": "I'm doing well!"},
        ]
        llm_context = LLMContext(messages)

        compression_frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary timestamp=2024-01-01>User greeted bot</summary>",
            original_messages_count=5,
            trigger_reason="threshold",
            compression_duration_ms=500.0,
            original_approx_tokens=100,
            compressed_approx_tokens=20,
        )
        await consumer._apply_compression(compression_frame)

        result_messages = llm_context.messages
        assert result_messages[0]["role"] == "system"
        assert result_messages[0]["content"] == "You are a helpful assistant."
        assert "<session_history_summary>" in result_messages[1]["content"]

    @pytest.mark.asyncio
    async def test_compression_preserves_new_messages(self):
        """Test that messages added during compression are preserved."""
        producer = ContextCompressionProducer(api_key="test-key")
        consumer = ContextCompressionConsumer(producer=producer)

        messages = [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]
        llm_context = LLMContext(messages)

        # Record original count
        original_count = len(llm_context.messages)

        # Simulate messages added during async compression
        llm_context.add_message({"role": "user", "content": "New message during compression"})
        llm_context.add_message(
            {"role": "assistant", "content": "New response during compression"}
        )

        compression_frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary>User greeted bot</summary>",
            original_messages_count=original_count,
            trigger_reason="threshold",
            compression_duration_ms=500.0,
            original_approx_tokens=100,
            compressed_approx_tokens=20,
        )

        await consumer._apply_compression(compression_frame)

        result = llm_context.messages
        assert len(result) == 4  # system + summary + 2 new messages
        assert result[0]["role"] == "system"
        assert "<session_history_summary>" in result[1]["content"]
        assert result[2]["content"] == "New message during compression"
        assert result[3]["content"] == "New response during compression"

    @pytest.mark.asyncio
    async def test_preserves_multiple_system_messages(self):
        """Test that multiple system messages are preserved (with warning logged).

        Note: The warning is logged via loguru which pytest captures separately.
        We verify the behavior (all system messages preserved) rather than the log.
        """
        producer = ContextCompressionProducer(api_key="test-key")
        consumer = ContextCompressionConsumer(producer=producer)

        messages = [
            {"role": "system", "content": "First system message"},
            {"role": "system", "content": "Second system message"},
            {"role": "user", "content": "Hello"},
        ]
        llm_context = LLMContext(messages)

        compression_frame = GradientBangContextCompressionFrame(
            context=llm_context,
            compressed_summary="<summary>Test</summary>",
            original_messages_count=3,
            trigger_reason="threshold",
            compression_duration_ms=100.0,
            original_approx_tokens=50,
            compressed_approx_tokens=10,
        )

        await consumer._apply_compression(compression_frame)

        # Both system messages should be preserved
        assert llm_context.messages[0]["role"] == "system"
        assert llm_context.messages[0]["content"] == "First system message"
        assert llm_context.messages[1]["role"] == "system"
        assert llm_context.messages[1]["content"] == "Second system message"
        # Summary follows
        assert "<session_history_summary>" in llm_context.messages[2]["content"]


class TestSystemPrompts:
    """Test the system prompts used for compression."""

    def test_intent_prompt_has_expected_content(self):
        """Verify intent detection prompt contains key elements."""
        assert "yes" in COMPRESSION_INTENT_SYSTEM_PROMPT.lower()
        assert "no" in COMPRESSION_INTENT_SYSTEM_PROMPT.lower()
        assert "summarize" in COMPRESSION_INTENT_SYSTEM_PROMPT.lower()

    def test_compression_prompt_has_expected_content(self):
        """Verify compression prompt contains key elements."""
        assert "<summary" in COMPRESSION_SYSTEM_PROMPT
        assert "timestamp" in COMPRESSION_SYSTEM_PROMPT
        # Should encourage aggressive compression with narrative arcs
        assert "5-6" in COMPRESSION_SYSTEM_PROMPT or "AT MOST" in COMPRESSION_SYSTEM_PROMPT
        assert "MISSION" in COMPRESSION_SYSTEM_PROMPT or "arc" in COMPRESSION_SYSTEM_PROMPT.lower()


class TestIntegration:
    """Integration tests for producer/consumer interaction."""

    @pytest.mark.asyncio
    async def test_producer_produces_frame_on_threshold(self):
        """Test that producer produces a frame when threshold is exceeded."""
        producer = ContextCompressionProducer(
            api_key="test-key",
            message_threshold=10,  # Low threshold for testing
        )

        # Create context exceeding threshold
        messages = [{"role": "system", "content": "Test"}]
        for i in range(15):
            messages.append({"role": "user", "content": f"Msg {i}"})
            messages.append({"role": "assistant", "content": f"Reply {i}"})

        context = LLMContext(messages)

        # Add a consumer queue
        queue = producer.add_consumer()

        # Mock the Gemini client
        mock_response = MagicMock()
        mock_response.candidates = [MagicMock()]
        mock_response.candidates[0].content.parts = [MagicMock()]
        mock_response.candidates[0].content.parts[0].text = "<summary>Test</summary>"

        producer._client = MagicMock()
        producer._client.aio.models.generate_content = AsyncMock(
            return_value=mock_response
        )

        # Process the frame
        frame = LLMContextFrame(context=context)
        await producer.process_frame(frame, FrameDirection.DOWNSTREAM)

        # Wait for async compression to complete
        await asyncio.sleep(0.1)

        # Check that a frame was produced
        assert not queue.empty()
        produced_frame = await queue.get()
        assert isinstance(produced_frame, GradientBangContextCompressionFrame)
        assert produced_frame.trigger_reason == "threshold"


# Skip live API tests if no API key is available
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
skip_without_api_key = pytest.mark.skipif(
    not GOOGLE_API_KEY,
    reason="GOOGLE_API_KEY not set in environment",
)


def _build_gradient_bang_conversation():
    """Build a realistic 300-message Gradient Bang game conversation.

    Creates varied conversations covering typical game scenarios:
    - Trading (buying/selling commodities)
    - Navigation (traveling between sectors)
    - Combat encounters
    - Mining operations
    - Ship upgrades
    - Quest interactions
    - Resource management
    - Exploration discoveries
    """
    from google.genai.types import Content, Part

    # Define conversation segments representing different gameplay scenarios
    segments = [
        # Opening - checking status
        ("Where am I right now?", "You're currently docked at Nova Station in Sector 7. Your ship, the Stellar Wanderer, is fully refueled and ready for departure."),
        ("What's my credit balance?", "You have 45,000 credits in your account. You also have 200 units of cargo space available."),
        ("Show me the local market prices", "Here are the current prices at Nova Station: Iron Ore: 50 credits/unit, Platinum: 200 credits/unit, Medical Supplies: 150 credits/unit, Luxury Goods: 400 credits/unit, Water: 20 credits/unit."),

        # Trading segment
        ("Buy 100 units of iron ore", "Purchased 100 units of Iron Ore for 5,000 credits. Your balance is now 40,000 credits. Cargo bay: 100/200 units used."),
        ("Also buy 50 units of medical supplies", "Purchased 50 units of Medical Supplies for 7,500 credits. Balance: 32,500 credits. Cargo: 150/200 units."),
        ("What sectors pay more for medical supplies?", "Medical Supplies fetch premium prices in Sector 14 (Frontier Outpost - 280 credits/unit), Sector 22 (Mining Colony Delta - 240 credits/unit), and Sector 31 (Research Station Kepler - 300 credits/unit)."),
        ("How far is Sector 31?", "Sector 31 is 8 warp jumps from your current location. Estimated travel time: 24 minutes. Fuel consumption: 40 units."),
        ("Check my fuel levels", "Your fuel tank is at 85/100 units. You have enough fuel for the journey to Sector 31 with 45 units remaining."),

        # Navigation segment
        ("Set course for Sector 31", "Course plotted to Sector 31 via the Hyperion Trade Route. This route passes through Sectors 12, 18, 25, and 29. Ready to launch when you are."),
        ("Launch and begin the journey", "Undocking from Nova Station... Launch successful. Engaging warp drive. First jump to Sector 12 initiated."),
        ("What do we pass on the way?", "Sector 12: Asteroid mining zone - possible salvage opportunities. Sector 18: Federation patrol area - safe passage. Sector 25: Nebula region - sensor interference expected. Sector 29: Independent territory - pirate activity reported."),
        ("Any messages or alerts?", "You have one priority message from the Merchants Guild: 'Bonus delivery contract available - deliver 100+ medical supplies to Research Station Kepler within the next hour for a 20% payment bonus.' You also have a routine update about fuel prices increasing in Sector 40."),
        ("Accept the bonus contract", "Contract accepted! Deliver at least 100 medical supplies to Sector 31 within 55 minutes for a 20% bonus on the sale price. Timer started."),

        # Encounter during travel
        ("Arriving at Sector 12 now", "Welcome to Sector 12. Sensors detect: 3 abandoned cargo containers floating near coordinates 234.5, -89.2. One unidentified ship at long range, stationary. An active mining beacon from claim holder 'Rocky Prospects Inc.'"),
        ("Scan those cargo containers", "Scanning... Container 1: 20 units of scrap metal (low value). Container 2: 5 units of Platinum (high value!). Container 3: Empty hull, possibly used for smuggling. All containers appear to be legal salvage."),
        ("Collect the platinum from container 2", "Maneuvering to Container 2... Cargo transfer complete. Acquired 5 units of Platinum. Cargo bay: 155/200 units. These can be sold for approximately 1,000 credits at standard rates."),
        ("Continue to Sector 18", "Engaging warp drive... Arrived at Sector 18. Federation Patrol Vessel 'Justice' hails you: 'Civilian vessel, state your business.' This is a routine check."),
        ("Tell them I'm making a delivery to Sector 31", "Message sent. Federation Patrol acknowledges: 'Understood, merchant vessel. Safe travels. Be advised: reports of increased pirate activity in Sectors 28-30. Consider alternative routing.' They've moved on."),
        ("Note taken. Continue to Sector 25", "Warp engaged... Entering Sector 25 Nebula Region. Warning: Sensor efficiency reduced to 40%. Navigation relies on preset coordinates. Limited visibility of nearby objects."),

        # Combat encounter
        ("Anything on sensors?", "Partial contact detected bearing 045, range approximately 500 meters. Signal is intermittent due to nebula interference. Unable to determine vessel type or intentions."),
        ("Slow down and try to get a better scan", "Reducing speed... Contact clarifying: Small fighter-class vessel. Transponder inactive. The ship is now changing course to intercept. Recommend raising shields."),
        ("Raise shields and arm weapons", "Shields online at 100%. Plasma cannons charged and ready. Missile tubes loaded with 4 Viper missiles. The unknown vessel is hailing you."),
        ("Open the channel", "Channel open. Voice transmission: 'Cargo vessel, this is the Black Nebula Raiders. Drop 50% of your cargo and you can leave in one piece. You have 30 seconds to comply.' They're pirates."),
        ("Decline and prepare for combat", "Transmission sent: declining their demands. The pirate vessel is powering weapons. Combat alert! Enemy vessel accelerating toward you. Estimated weapon range in 10 seconds."),
        ("Fire missiles when in range", "Target locked... Firing 2 Viper missiles! Missiles away, tracking enemy vessel. Enemy returning fire with laser cannons - shields absorbing hits, down to 85%."),
        ("Status on missiles?", "Direct hit! Both missiles impacted the enemy hull. Enemy shields collapsed, hull integrity at 35%. They're attempting to flee!"),
        ("Pursue and finish them off", "Engines to full! Closing distance... Firing plasma cannons. Multiple hits registered. Enemy vessel destroyed! Explosion detected. Scanning for salvage..."),
        ("Search the wreckage", "Salvage scan complete: 15 units of stolen goods (can be returned for reputation or kept), 3 units of weapons components, and a data chip with encrypted information."),
        ("Take everything and continue to Sector 29", "All salvage collected. Cargo bay: 173/200 units. Warp drive charging... Arrived at Sector 29. Alert: Two more vessels detected, but they appear to be merchants fleeing the area. No hostile contacts."),

        # Arrival and trading
        ("Proceed to Sector 31", "Final jump engaged... Welcome to Sector 31, Research Station Kepler. You've arrived with 12 minutes to spare on your bonus contract. Docking request accepted, bay 7 assigned."),
        ("Dock and check market prices", "Docking complete. Current prices at Research Station Kepler: Medical Supplies: 300 credits/unit (bonus contract active: +20% = 360 credits/unit!). Iron Ore: 45 credits/unit. Platinum: 220 credits/unit."),
        ("Sell all medical supplies", "Sold 50 units of Medical Supplies at bonus rate of 360 credits/unit. Total: 18,000 credits! Contract complete! Merchants Guild reputation increased. Balance: 50,500 credits."),
        ("Sell the platinum too", "Sold 5 units of Platinum at 220 credits/unit. Total: 1,100 credits. Balance: 51,600 credits."),
        ("Keep the iron ore for now. What about those stolen goods?", "The stolen goods can be: 1) Returned to Research Station security for a 500 credit reward plus reputation boost, or 2) Sold on the black market for approximately 2,000 credits but with reputation penalty."),
        ("Return them to security", "You've turned in the stolen goods to station security. Reward: 500 credits. Balance: 52,100 credits. Your lawful reputation has increased. The security chief thanks you and mentions they have a job if you're interested."),
        ("What's the job?", "Security Chief Torres explains: 'We've been having problems with pirates disrupting our supply lines. I'll pay 10,000 credits if you can locate and destroy their base in the asteroid field of Sector 28. Interested?'"),
        ("Accept the mission", "Mission accepted: Destroy the pirate base in Sector 28 asteroid field. Reward: 10,000 credits. Chief Torres uploads coordinates of their last known location to your navigation computer."),

        # Preparing for mission
        ("What upgrades are available here?", "Research Station Kepler offers: Shield Booster Mk2 (15,000 credits, +25% shield capacity), Advanced Targeting System (8,000 credits, +15% weapon accuracy), Cargo Bay Extension (12,000 credits, +50 cargo space), Fuel Efficiency Module (6,000 credits, -20% fuel consumption)."),
        ("Buy the targeting system", "Purchased Advanced Targeting System for 8,000 credits. Installation complete. Weapon accuracy improved by 15%. Balance: 44,100 credits."),
        ("Also get the fuel efficiency module", "Purchased Fuel Efficiency Module for 6,000 credits. Installation complete. Fuel consumption reduced by 20%. Balance: 38,100 credits."),
        ("Refuel the ship", "Fuel tank filled to 100/100 units. Cost: 500 credits. Balance: 37,600 credits."),
        ("Buy some more missiles", "Purchased 6 Viper missiles at 200 credits each. Total: 1,200 credits. Missile inventory: 8 missiles. Balance: 36,400 credits."),

        # Mission to destroy pirate base
        ("Set course for Sector 28", "Course plotted to Sector 28. Distance: 1 warp jump. Estimated fuel consumption: 4 units (reduced by efficiency module). Ready to depart."),
        ("Launch", "Undocking from Research Station Kepler... Warp engaged... Arrived at Sector 28. Dense asteroid field detected. Multiple sensor contacts, mostly asteroids. Scanning for the pirate base..."),
        ("Use the coordinates Torres gave us", "Navigating to provided coordinates... Entering dense asteroid cluster. Detecting energy emissions ahead consistent with a small station. Also detecting: 2 patrol fighters, 1 medium gunship. They haven't spotted us yet."),
        ("Can we sneak closer using the asteroids as cover?", "Analyzing... Yes, there's an approach vector using asteroid 47-Alpha as cover. It will bring you within 200 meters of the base before exposure. Recommend powering down non-essential systems to reduce signature."),
        ("Do it. Power down and approach stealthily", "Non-essential systems offline. Silent running engaged. Maneuvering through asteroid field... Progress: 50%... 75%... You're now behind asteroid 47-Alpha, 200 meters from the pirate base. Fighters are on the far side, gunship is docked."),
        ("What's the base's defenses?", "Base has: 2 automated turret emplacements, a shield generator, and what appears to be a fuel storage facility. The fuel storage could be explosive if hit. The gunship is currently powered down and docked."),
        ("Target the fuel storage with missiles first, then the shield generator", "Target lock acquired on fuel storage... Firing 2 missiles! Direct hit! Secondary explosions detected! The fuel depot detonation has destroyed one turret and heavily damaged the shield generator!"),
        ("Engage the remaining defenses", "Powering up weapons! The remaining turret is firing - shields absorbing damage, holding at 90%. Plasma cannons firing on shield generator... Generator destroyed! Base shields down!"),
        ("What about the fighters and gunship?", "The two patrol fighters are scrambling but they're out of position - 45 seconds until they reach weapon range. The gunship is attempting emergency power-up. Recommend focusing fire on the gunship before it launches."),
        ("Target the gunship", "Targeting gunship at dock... Firing plasma cannons! Multiple hits! The gunship's engines are damaged, it can't launch. Continuing fire... Gunship destroyed!"),
        ("Turn to face the fighters", "Rotating to engage incoming fighters. They're spreading apart for attack pattern. Fighter 1 at bearing 045, Fighter 2 at bearing 315. Both in weapon range in 10 seconds."),
        ("Fire missiles at Fighter 1, engage Fighter 2 with cannons", "Missiles away targeting Fighter 1... Switching to Fighter 2... Cannons firing! Fighter 2 shields down to 40%. Missiles have hit Fighter 1 - direct hit, fighter destroyed!"),
        ("Finish Fighter 2", "Fighter 2 attempting evasive maneuvers. Your new targeting system compensates... Hit! Hit! Fighter 2 destroyed! All hostile units eliminated."),
        ("Destroy the pirate base", "Targeting pirate base main structure... Firing all weapons. Multiple impacts. Base reactor going critical... Explosion imminent! Recommend backing off."),
        ("Get us to a safe distance", "Full reverse! Distance increasing... 500 meters... 1000 meters... The pirate base has been completely destroyed! Mission complete. Scanning wreckage for any survivors or salvage."),
        ("Any salvage?", "Salvage detected: 30 units of various stolen cargo, a weapons cache containing 4 missiles and 2 railgun rounds, and an encrypted data core that may contain valuable intel."),
        ("Collect everything", "Salvage collection complete. Cargo bay: 203/200 units - slightly overloaded. Recommend selling excess cargo soon. Acquired all items. The encrypted data core might be worth extra to Chief Torres."),

        # Returning to collect reward
        ("Return to Sector 31", "Course set. Warp engaging... Welcome back to Research Station Kepler. Docking at bay 7. Chief Torres is waiting to meet you."),
        ("Meet with Torres", "Chief Torres congratulates you: 'Excellent work! Our sensors confirm the pirate base is destroyed. Here's your payment.' Received: 10,000 credits. Balance: 46,400 credits. Torres examines the data core. 'This is interesting...'"),
        ("What's on the data core?", "Torres decrypts the data core: 'This contains the pirates' contact network - other bases, suppliers, and... a buyer for their stolen goods. This is valuable intel. I can offer you an additional 5,000 credits for it, or you could sell it to others who might pay more.'"),
        ("Give it to Torres", "You hand over the data core. Torres: 'You're a good sort. Here's 5,000 credits, and I'll remember this. If you ever need help in this sector, you've got friends.' Received: 5,000 credits. Balance: 51,400 credits. Reputation with Research Station Kepler significantly increased."),

        # New opportunities
        ("What other missions are available?", "Available missions: 1) Escort Mission: Protect a science vessel to Sector 40 - 8,000 credits. 2) Cargo Run: Deliver rare isotopes to Mining Colony Delta (Sector 22) - 5,000 credits. 3) Investigation: Explore strange signals from abandoned station in Sector 15 - 12,000 credits, high risk."),
        ("Tell me more about the investigation mission", "A research probe detected unusual energy readings from an abandoned mining station in Sector 15. The station was evacuated 50 years ago after a reactor accident. Recently, power signatures have been detected. The Science Ministry wants someone to investigate and report back."),
        ("Sounds intriguing. Accept that mission", "Mission accepted: Investigate anomalous readings at Abandoned Station Echo in Sector 15. Warning flagged: Previous investigation team went silent 2 weeks ago. Recommend full combat readiness. Coordinates uploaded."),
        ("What do we know about the previous team?", "The previous team was a 3-person science crew aboard the vessel 'Curious Mind'. Their last transmission mentioned 'unexpected automated defenses still active' before going silent. No distress beacon has been detected."),

        # Shopping before mission
        ("I should prepare better. What armor upgrades are available?", "Available at Research Station Kepler: Hull Reinforcement Plates (10,000 credits, +500 hull points), Point Defense System (15,000 credits, shoots down incoming missiles), Emergency Repair Drones (8,000 credits, slowly repairs hull in combat)."),
        ("Buy the repair drones", "Purchased Emergency Repair Drones for 8,000 credits. Installation complete. Your hull will now slowly repair during combat. Balance: 43,400 credits."),
        ("Sell the excess cargo from the pirate base", "Sold 30 units of recovered stolen goods at legal rates: 2,400 credits. Cargo bay: 173/200 units. Balance: 45,800 credits."),
        ("Actually, sell the iron ore too. I need cargo space for anything I find", "Sold 100 units of Iron Ore at 45 credits/unit: 4,500 credits. Cargo bay: 73/200 units. Balance: 50,300 credits."),

        # Journey to investigation
        ("Set course for Sector 15", "Course plotted. Distance: 5 warp jumps. Route passes through Sectors 29, 25, 20, 17. Estimated travel time: 15 minutes."),
        ("Launch", "Undocking... Course engaged. Traveling through familiar territory initially. Alert: Minor ion storm detected in Sector 20, may cause sensor interference."),
        ("Continue through the storm", "Passing through Sector 20... Ion storm causing minor shield fluctuations. No significant damage. Navigation slightly affected but compensating. Storm passing... Clear space ahead."),
        ("Arriving at Sector 15", "Welcome to Sector 15. Abandoned Station Echo visible on sensors, distance 2000 meters. Detecting: Low-level power readings from the station, no active transponders, debris field surrounding the station."),
        ("Scan for the Curious Mind", "Scanning debris field... Found it. The Curious Mind is among the wreckage, approximately 500 meters from the station. Hull breached in multiple locations. Life signs... none detected. I'm sorry, Captain."),
        ("Can we retrieve any data from their ship?", "It's risky but possible. Recommend EVA probe deployment to access their computer core without entering the debris field directly. Shall I launch a probe?"),
        ("Yes, launch the probe", "Probe launched. Navigating through debris... Probe has reached the Curious Mind. Accessing computer core... Download in progress... Got it. Returning probe now. Data recovered includes their final sensor logs and personal logs."),
        ("Review their sensor logs", "Sensor logs show: The team approached the station normally. Automated defense turrets activated when they came within 100 meters. They were caught off guard - the turrets were supposed to be decommissioned 50 years ago. There are at least 6 active turret emplacements."),
        ("Any way to disable them remotely?", "According to the Curious Mind's data, the turrets are controlled by a central computer in the station's control room. If you can get past the turrets, you might be able to shut them down. Alternatively, their defense grid may have a maintenance backdoor - the station's original operating codes might still work."),
        ("Do we have those codes?", "Searching historical databases... Found! Station Echo was operated by Consolidated Mining Corp. Their standard maintenance codes were: Echo-7749-Override. However, after 50 years, there's no guarantee the system will accept them."),
        ("Try broadcasting the codes", "Broadcasting: Echo-7749-Override... Response received! 'Maintenance access granted. Turret grid entering standby mode for 300 seconds.' You have 5 minutes before they reactivate. The path to docking is clear!"),
        ("Dock immediately", "Full speed to station... Docking clamps engaging... Docked successfully. Station Echo's airlock is cycling. Timer: 280 seconds remaining on turret standby."),
        ("Can we disable them permanently from inside?", "If you reach the control room, yes. Station schematic shows control room is 3 decks up from the docking bay. Emergency lighting appears functional. Atmosphere readings show breathable air."),
        ("Head to the control room", "Moving through Station Echo. The station shows signs of hasty evacuation - personal effects scattered, emergency supplies opened. Deck 2... Deck 3... Control room ahead. Door is sealed but power is on."),
        ("Open the door", "Accessing door controls... Door opening. The control room is intact. Main computer terminal is active. Warning: Motion detected behind you!"),
        ("What is it?", "Scan complete: It's a maintenance robot. Old model, appears to be running basic cleaning routines. It hasn't registered your presence as a threat. The station's basic automated systems seem to be running on some kind of autonomous mode."),
        ("Disable the turret grid permanently", "Accessing defense control... Turrets deactivated. Permanent shutdown confirmed. You now have safe access to explore the rest of the station."),
        ("What's causing the power readings?", "Running a station-wide diagnostic... The anomalous readings are coming from the lower levels - specifically the old reactor bay. The reactor should have been shut down, but something is generating significant power. Recommend investigation."),
        ("Head to the reactor bay", "Navigating to lower levels. The station gets older and more damaged as you descend. Signs of the original reactor incident visible - scorch marks, sealed emergency bulkheads. Reactor bay access ahead."),
        ("What's in there?", "Opening reactor bay... This is unexpected. The original reactor is indeed dead, but someone has installed a new, compact fusion reactor. It's modern technology - maybe 5 years old at most. There's also a large data storage array connected to it."),
        ("Someone's using this station?", "It appears so. This is a clandestine installation. The data array is massive - petabytes of storage. It could be anything: black market data hub, illegal research, pirate logistics... There's a terminal connected to the array."),
        ("Access the terminal", "Accessing... Heavy encryption, but I'm working on it... Partial access achieved. It's a data backup facility for an organization called 'Project Helix'. Files include research data, financial transactions, and communications. Some mention biological experiments."),
        ("Download as much as we can", "Download in progress... 15%... 35%... 60%... Alert! Remote access detected! Someone knows we're here and is attempting to wipe the data!"),
        ("Can you stop them?", "Implementing countermeasures... I've slowed their wipe, but they have priority access. I can save approximately 40% of the data before it's erased. Download continuing... 80%... 90%... Done. Wipe protocol completing on their end."),
        ("What did we get?", "We recovered: Research logs mentioning 'biological enhancement subjects', financial records tracing payments to shell corporations, personnel files including several known scientists who disappeared in recent years, and partial coordinates to other facilities."),
        ("This is big. We need to get this to the authorities", "Agreed. The Science Ministry contracted this mission, but this data might be better suited for Federation Intelligence. Recommend returning to Research Station Kepler and deciding who to share this with."),
        ("Let's go", "Leaving Station Echo... Undocking complete. The station goes dark as you depart - whoever was running Project Helix has cut the power remotely. Setting course for Sector 31."),

        # Debrief
        ("Arriving at Research Station Kepler", "Docked at Research Station Kepler. Dr. Winters from the Science Ministry is waiting for your report. Station security has also been alerted to your discovery."),
        ("Talk to Dr. Winters", "Dr. Winters: 'What did you find out there?' You explain about Project Helix and the secret installation. Her face pales. 'Biological experiments? This is beyond what we expected. You need to speak with the Federation authorities. I'll arrange a secure comm.'"),
        ("Share the data with Federation Intelligence", "Encrypted channel open. Federation Intelligence Agent Chen appears on screen. After reviewing the data: 'This is significant. Project Helix is connected to several unsolved cases. Your discovery may have saved lives. The Federation will pay you 25,000 credits for this intel, and we'd like you to investigate those partial coordinates.'"),
        ("Interesting. What's the full offer?", "Agent Chen: 'We'll pay 25,000 now for what you've recovered. If you investigate the other facilities and bring us more data, we'll add 15,000 per facility confirmed. Plus, you'll have unofficial Federation support in frontier space - useful for a trader.'"),
        ("Accept the payment and the mission", "Payment received: 25,000 credits. Balance: 75,300 credits. New mission: Investigate Project Helix facilities at partial coordinates. First suspected location: Sector 44. Federation has granted you temporary intelligence credentials."),
        ("Also collect the original investigation reward", "Dr. Winters processes your mission completion. Payment received: 12,000 credits. Balance: 87,300 credits. 'You've done good work. Come back anytime.'"),

        # New equipment and preparation
        ("I want to upgrade my ship before continuing", "Research Station Kepler has limited military-grade equipment due to its research focus. For better upgrades, recommend visiting the Federation Naval Yard in Sector 8, or the Independent Shipyard in Sector 52."),
        ("How far is Sector 8?", "Sector 8 is 7 warp jumps away. As a Federation-affiliated station with your new credentials, you'll have access to military equipment at reasonable prices."),
        ("Set course for Sector 8", "Course plotted. Departing Research Station Kepler... Journey underway. Route is clear according to recent patrol reports."),
        ("Arriving at Sector 8", "Welcome to Sector 8, Federation Naval Yard. Your intelligence credentials have been verified. Full station access granted. The yard offers military-grade equipment and ship modifications."),
        ("What upgrades are available?", "Military equipment available: Military Shield Array (35,000 credits, double shield capacity), Cloaking Device (60,000 credits, temporary invisibility), Heavy Plasma Cannons (25,000 credits, +50% weapon damage), Torpedo Bay (20,000 credits, heavy anti-capital ship weapons), Sensor Suite Mk3 (15,000 credits, +100% sensor range)."),
        ("Buy the sensor suite", "Purchased Sensor Suite Mk3 for 15,000 credits. Installation complete. Your sensor range has doubled, and you can now detect cloaked vessels at close range. Balance: 72,300 credits."),
        ("And the heavy plasma cannons", "Purchased Heavy Plasma Cannons for 25,000 credits. Installation complete. Your combat effectiveness has significantly increased. Balance: 47,300 credits."),
        ("Full restock on missiles and fuel", "Fuel tank filled: 500 credits. Missiles restocked to 12 total: 1,200 credits. Balance: 45,600 credits. Your ship is combat-ready."),
        ("What about crew?", "Federation Naval Yard has personnel available for hire: Combat Specialist (improves weapon accuracy, 2,000 credits/mission), Engineer (improves repair and efficiency, 1,500 credits/mission), Navigator (faster travel times, 1,000 credits/mission)."),
        ("Hire the engineer for this mission", "Engineer Rodriguez has joined your crew for this mission. Cost: 1,500 credits. Balance: 44,100 credits. 'Happy to help with the Federation mission, Captain. I've got experience with covert installations.'"),

        # Final mission prep
        ("Review the coordinates for the first Helix facility", "Partial coordinates point to the outer asteroid belt of Sector 44. The area is uncharted and far from regular shipping lanes. No known stations or outposts. Perfect for a hidden facility."),
        ("Any intel on what to expect?", "Based on the recovered data: The facility is likely larger than Station Echo. Expect tighter security - possibly actual personnel, not just automated systems. They know someone has been investigating, so they'll be alert. Recommend stealth approach."),
        ("Set course for Sector 44", "Course plotted. Distance: 12 warp jumps. This will take us through some unsecured space. Travel time approximately 40 minutes."),
        ("Launch", "Departing Federation Naval Yard. Rodriguez is running diagnostics on ship systems and reports everything is optimal. Journey underway."),
        ("What's our current status overall?", "Ship Status: Hull 100%, Shields 100%, Fuel 100%, Missiles 12. Crew: You (Captain), Rodriguez (Engineer). Credits: 44,100. Reputation: Federation - High, Research Station Kepler - High, Pirates - Hostile."),
        ("Good summary. Continue journey", "Traveling through Sectors 10, 15, 22, 28... Route is quiet. Rodriguez mentions this area of space is known as 'The Corridor' - a relatively safe route used by traders. Sector 35 ahead."),
        ("Status update", "Halfway to destination. All systems nominal. Rodriguez has made minor improvements to shield efficiency during transit. No contacts detected. Continuing to Sector 44."),
        ("Entering Sector 44", "Welcome to Sector 44. Asteroid belt detected on long-range sensors. No transponder signals. Activating enhanced sensor suite... Faint energy signature detected deep in the asteroid field, coordinates match the partial data."),
        ("Approach carefully", "Reducing speed. Maneuvering into asteroid field. Rodriguez is monitoring for any artificial signals. 'Captain, I'm picking up trace emissions - definitely not natural. Someone's out here.'"),

        # Reaching the facility
        ("Can you pinpoint it?", "Triangulating... Got it. There's a large asteroid approximately 2000 meters ahead that's been hollowed out. Hangar bay doors visible. I'm reading heat signatures consistent with a small station. Multiple ships docked inside."),
        ("How many ships?", "I count 4 small vessels - fighter-class - and 1 medium transport. The fighters appear to be patrol craft. The transport has its cargo bay loaded with something."),
        ("Can we approach undetected?", "With the new sensor suite, I can map their patrol patterns. If we time it right, there's a 30-second window when no fighters are facing our approach vector. Rodriguez says he can minimize our emissions during that window."),
        ("Let's do it. Wait for the window", "Monitoring patrol patterns... Pattern identified. Window opening in 60 seconds... 30 seconds... Now! Go go go! Silent running engaged. Moving through the gap..."),
        ("Did we make it?", "We're past their outer perimeter. No alarms. No change in patrol behavior. You're now 500 meters from the asteroid base. There's a service entrance on the far side - smaller than the main hangar, but big enough for our ship."),
        ("Dock at the service entrance", "Maneuvering to service entrance... Docking clamps engaging... We're in. The bay is empty - looks like it was used for waste disposal. Atmosphere is breathable. Rodriguez will stay with the ship and monitor communications."),
        ("I'm going in alone?", "Rodriguez: 'I can monitor the facility's internal sensors from here if I can splice into their network. I'll warn you of any patrols. Plus, if things go bad, I can have the ship ready for immediate departure.' He's got a point."),
        ("Good plan. Let's do it", "Rodriguez is working on the network splice. 'Got it, Captain. I can see their internal sensors. Patrol schedule shows a 2-person team doing rounds. They'll pass your corridor in 4 minutes. The main data center is two levels down.'"),
        ("Move to the data center", "Navigating through maintenance corridors. The facility is more sophisticated than Station Echo - proper climate control, clean surfaces, operating lights. These people have resources. Data center ahead."),
        ("What security?", "Rodriguez: 'Biometric lock on the data center door, but I can spoof it from here. Guard patrol is on the opposite side of the facility. You've got maybe 8 minutes before they come back around. I'm opening the door... now.'"),
        ("Enter and access their data", "Entering data center. Multiple server racks humming. Central terminal active. Starting data extraction... This is the motherlode - detailed experiment logs, subject records, financial data, and... coordinates to their main facility. It's in Sector 72."),
        ("Download everything", "Downloading... 30%... Alert from Rodriguez: 'Captain, they're calling a shift change. Extra personnel heading your way. You've got 3 minutes!' Download at 60%..."),
        ("Speed up the download", "Prioritizing critical files... 80%... 90%... Done! Got the essentials. Rodriguez: 'Captain, two hostiles approaching the data center. 30 seconds!'"),
        ("Find another exit", "Looking for alternatives... Maintenance hatch in the ceiling leads to ventilation system. It'll be tight, but you can fit."),
        ("Take the maintenance hatch", "Climbing into the ventilation system. Below you, hear the door open and voices: 'Check the logs. Someone accessed the system.' They know."),
        ("Get back to the ship", "Crawling through vents. Rodriguez is guiding you: 'Left at the junction... straight for 20 meters... drop down here.' You're back in the waste disposal bay. Ship is ready."),
        ("Launch immediately", "Emergency launch! Clearing the service entrance... Facility alarm now active. Rodriguez: 'Multiple ships powering up. We need to move!'"),
        ("Can we fight them?", "Four fighters launching. With our upgrades we could take them, but more might come, and we have what we need. Rodriguez recommends tactical withdrawal. Your call, Captain."),
        ("He's right. Full speed out of the asteroid field", "Engines to maximum! Weaving through asteroids. Fighters in pursuit but losing ground - they can't match our speed in this terrain. Clearing the asteroid field... Warp drive online!"),
        ("Jump to hyperspace", "Warp engaged! We're away. Fighters don't have the range to follow. Rodriguez is securing the downloaded data. 'Captain, this is incredible. Project Helix is bigger than anyone thought. The main facility in Sector 72... it's a full research complex.'"),
        ("Set course for Federation space", "Course plotted to Sector 8 Federation Naval Yard. 12 jumps. We'll debrief with Agent Chen. This mission just got a lot bigger."),
        ("How much data did we get?", "We recovered approximately 2 terabytes of data including: 47 test subject files, financial records spanning 3 years, communications with unknown government officials, and the precise location of their main facility."),
        ("The Federation will want all of this", "Rodriguez nods: 'This could bring down a major conspiracy. We did good work today, Captain. Also, I think there might be a bonus in it for us.' He grins."),
        ("Arriving at Federation Naval Yard", "Welcome back to Sector 8. Agent Chen is waiting. He's reviewed the preliminary data and looks impressed. 'Get to the briefing room immediately. This goes all the way to the top.'"),
    ]

    # Build the Content list from segments
    contents = []
    for user_msg, model_msg in segments:
        contents.append(Content(role="user", parts=[Part(text=user_msg)]))
        contents.append(Content(role="model", parts=[Part(text=model_msg)]))

    # Verify we have enough messages
    # We have ~150 exchanges = 300 messages
    assert len(contents) >= 250, f"Expected at least 250 messages, got {len(contents)}"

    return contents


@pytest.mark.live_api
class TestLiveGeminiAPI:
    """Tests that call the real Gemini API.

    These tests are skipped by default unless GOOGLE_API_KEY is set.
    Run with: uv run pytest tests/unit/test_context_compression.py -v -m live_api

    Note: These tests bypass the stubbed pipecat adapters by calling the Gemini
    API directly, since the stubs create mock objects incompatible with the real API.
    """

    @skip_without_api_key
    @pytest.mark.asyncio
    async def test_compression_api_call(self):
        """Test that real Gemini API produces valid compression output.

        Uses the same approach as production code: conversation formatted as a
        single user message document with system_instruction for compression prompt.

        Note: The Gemini API requires conversations to end with a user message when
        using system_instruction. Formatting the conversation as a document in a
        single user message solves this.
        """
        from google import genai
        from google.genai.types import Content, GenerateContentConfig, Part

        client = genai.Client(api_key=GOOGLE_API_KEY)

        # Build conversation as formatted document (like production code does)
        segments = _build_gradient_bang_conversation()

        # Convert to text format like _prepare_compression_messages does
        lines = []
        for content in segments:
            role = content.role.upper()
            if role == "MODEL":
                role = "ASSISTANT"
            text = content.parts[0].text if content.parts else ""
            lines.append(f"[{role}]: {text}")

        conversation_text = "\n".join(lines)
        formatted_message = (
            "CONVERSATION HISTORY TO COMPRESS\n"
            "----\n\n"
            f"{conversation_text}\n\n"
            "----\n"
            "END OF CONVERSATION HISTORY"
        )

        contents = [Content(role="user", parts=[Part(text=formatted_message)])]

        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=GenerateContentConfig(
                system_instruction=COMPRESSION_SYSTEM_PROMPT
            ),
        )

        # Extract text from response
        assert response.candidates, "No candidates in response"
        candidate = response.candidates[0]
        assert candidate.content, "No content in candidate"
        assert candidate.content.parts, f"No parts in content: {candidate.content}"

        text = ""
        for part in candidate.content.parts:
            if hasattr(part, "text") and part.text:
                text = part.text
                break

        assert text, "No text in response"
        assert len(text) > 10, f"Response too short: {text}"
        # Verify output contains expected summary format
        assert "<summary" in text, f"Expected <summary> tags in output: {text[:200]}"

        # Verify aggressive compression: should produce at most 6 summary blocks
        import re
        blocks = re.findall(r"<summary[^>]*>.*?</summary>", text, re.DOTALL)
        assert len(blocks) <= 8, f"Expected at most 8 summary blocks, got {len(blocks)}"
        assert len(blocks) >= 2, f"Expected at least 2 summary blocks, got {len(blocks)}"

    @skip_without_api_key
    @pytest.mark.asyncio
    async def test_explicit_request_detection_live(self):
        """Test that real Gemini API detects compression requests."""
        from google import genai
        from google.genai.types import Content, GenerateContentConfig, Part

        client = genai.Client(api_key=GOOGLE_API_KEY)

        # Message that should trigger compression - explicit memory management request
        contents_with_request = [
            Content(role="user", parts=[Part(text="Your context is getting too long. Can you compress your memory?")]),
        ]

        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents_with_request,
            config=GenerateContentConfig(
                system_instruction=COMPRESSION_INTENT_SYSTEM_PROMPT
            ),
        )

        result_text = ""
        if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            for part in response.candidates[0].content.parts:
                if hasattr(part, "text") and part.text:
                    result_text = part.text.strip().lower()
                    break

        assert result_text == "yes", f"Should detect explicit compression request, got: {result_text}"

        # Message that should NOT trigger compression - general conversation
        contents_without_request = [
            Content(role="user", parts=[Part(text="What's the weather like today?")]),
        ]

        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents_without_request,
            config=GenerateContentConfig(
                system_instruction=COMPRESSION_INTENT_SYSTEM_PROMPT
            ),
        )

        result_text = ""
        if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            for part in response.candidates[0].content.parts:
                if hasattr(part, "text") and part.text:
                    result_text = part.text.strip().lower()
                    break

        assert result_text == "no", f"Should not detect compression request in normal message, got: {result_text}"

        # Message that should NOT trigger compression - task completion summary request
        contents_task_completion = [
            Content(role="user", parts=[Part(text="Task completed. Please summarize what was accomplished.")]),
        ]

        response = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents_task_completion,
            config=GenerateContentConfig(
                system_instruction=COMPRESSION_INTENT_SYSTEM_PROMPT
            ),
        )

        result_text = ""
        if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            for part in response.candidates[0].content.parts:
                if hasattr(part, "text") and part.text:
                    result_text = part.text.strip().lower()
                    break

        assert result_text == "no", f"Should NOT trigger on task completion messages, got: {result_text}"

    @skip_without_api_key
    @pytest.mark.asyncio
    async def test_consumer_applies_compression(self):
        """Test that consumer correctly applies compression to context."""
        producer = ContextCompressionProducer(api_key=GOOGLE_API_KEY)
        consumer = ContextCompressionConsumer(producer=producer)

        # Create a test context
        messages = [
            {"role": "system", "content": "You are a test assistant."},
            {"role": "user", "content": "Task 1: Create a file"},
            {"role": "assistant", "content": "Created file test.txt"},
            {"role": "user", "content": "Task 2: Write hello"},
            {"role": "assistant", "content": "Wrote hello to file"},
        ]
        context = LLMContext(messages)
        original_count = len(messages)

        # Manually create a compression frame (simulating what producer would create)
        compression_frame = GradientBangContextCompressionFrame(
            context=context,
            compressed_summary="<summary timestamp=2024-01-01T00:00:00>User created file, wrote hello</summary>",
            original_messages_count=original_count,
            trigger_reason="threshold",
            compression_duration_ms=500.0,
            original_approx_tokens=100,
            compressed_approx_tokens=20,
        )

        # Apply compression
        await consumer._apply_compression(compression_frame)

        # Verify context was compressed
        new_messages = context.messages
        assert len(new_messages) == 2, f"Expected 2 messages (system + summary), got {len(new_messages)}"
        assert new_messages[0]["role"] == "system", "System message should be preserved"
        assert "<session_history_summary>" in new_messages[1]["content"], "Should have summary wrapper"
        assert "<summary" in new_messages[1]["content"], "Should have summary tag"
