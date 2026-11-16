"""Unit tests for the session slot logic (no Azure resources required).

Run from the api folder:
    python -m unittest discover -s tests -v

The in-memory repository below emulates the Cosmos DB behaviors the logic
relies on: ETag-conditional patch (412 on conflict) and filter-predicate patch.
"""

import os
import sys
import threading
import unittest
from dataclasses import replace
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from shared.session_store import (  # noqa: E402
    SessionConfig,
    CosmosSlotRepository,
    SessionLimitReached,
    SessionStore,
    SlotRef,
    InvalidSessionRequest,
    load_session_config,
    make_session_key,
)


class InMemorySlotRepository:
    def __init__(self):
        self._lock = threading.Lock()
        self.slots = {}
        self._etag_seq = 0

    def _next_etag(self):
        self._etag_seq += 1
        return f'"{self._etag_seq}"'

    # Reads return snapshots, like a query result.
    def read_slot(self, slot_id):
        with self._lock:
            slot = self.slots.get(slot_id)
            return dict(slot) if slot else None

    def find_slot_by_key(self, session_key, max_sessions):
        with self._lock:
            for slot in self.slots.values():
                if slot["sessionKey"] == session_key and slot["slotNo"] < max_sessions:
                    return SlotRef(id=slot["id"], etag=slot["_etag"], expires_at=slot["expiresAt"])
        return None

    def find_free_slots(self, now, max_sessions, limit):
        with self._lock:
            free = [
                SlotRef(id=s["id"], etag=s["_etag"])
                for s in sorted(self.slots.values(), key=lambda s: s["slotNo"])
                if s["slotNo"] < max_sessions and s["expiresAt"] <= now
            ]
        return free[:limit]

    def count_active(self, now, max_sessions):
        with self._lock:
            return sum(1 for s in self.slots.values() if s["slotNo"] < max_sessions and s["expiresAt"] > now)

    def count_slots(self, max_sessions):
        with self._lock:
            return sum(1 for s in self.slots.values() if s["slotNo"] < max_sessions)

    def existing_slot_numbers(self):
        with self._lock:
            return {s["slotNo"] for s in self.slots.values()}

    def create_slot(self, slot_no):
        slot_id = f"slot-{slot_no:04d}"
        with self._lock:
            if slot_id in self.slots:
                return
            self.slots[slot_id] = {
                "id": slot_id,
                "slotNo": slot_no,
                "sessionKey": None,
                "userId": None,
                "acquiredAt": 0,
                "expiresAt": 0,
                "lastSeenAt": 0,
                "_etag": self._next_etag(),
            }

    def claim(self, slot, fields):
        with self._lock:
            current = self.slots.get(slot.id)
            if current is None or current["_etag"] != slot.etag:
                return False  # 404 / 412
            current.update(fields)
            current["_etag"] = self._next_etag()
            return True

    def update_if_owner(self, slot_id, session_key, fields, max_sessions=None):
        with self._lock:
            current = self.slots.get(slot_id)
            if current is None or current["sessionKey"] != session_key:
                return False
            if max_sessions is not None and current["slotNo"] >= max_sessions:
                return False
            current.update(fields)
            current["_etag"] = self._next_etag()
            return True


class FakeClock:
    def __init__(self, start=1_000_000):
        self.now = start

    def __call__(self):
        return self.now


def make_config(**overrides):
    base = SessionConfig(
        enabled=True,
        company_id="company-a",
        max_sessions=3,
        ttl_seconds=900,
        heartbeat_interval_seconds=300,
        count_mode="browser",
        release_on_close=True,
        enforce_on_api=True,
        cosmos_endpoint=None,
        cosmos_key=None,
        cosmos_database="sessiondb",
        cosmos_container="sessions",
    )
    return replace(base, **overrides)


def key_for(config, user, browser):
    return make_session_key(config, user, browser)


BROWSER_IDS = [f"00000000-0000-4000-8000-{i:012d}" for i in range(200)]


class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.config = make_config()
        self.repo = InMemorySlotRepository()
        self.clock = FakeClock()
        self.store = SessionStore(self.config, self.repo, clock=self.clock)

    def acquire(self, n, user="user01@contoso.com"):
        return self.store.acquire(key_for(self.config, user, BROWSER_IDS[n]), user)

    def test_slots_are_created_lazily(self):
        self.acquire(0)
        self.assertEqual(len(self.repo.slots), self.config.max_sessions)

    def test_limit_is_enforced(self):
        for i in range(3):
            self.acquire(i)
        with self.assertRaises(SessionLimitReached):
            self.acquire(3)

    def test_same_browser_gets_same_slot(self):
        first = self.acquire(0)
        second = self.acquire(0)
        self.assertEqual(first.slot_id, second.slot_id)
        self.assertEqual(self.store.status()["activeSessions"], 1)

    def test_expired_slot_is_reused(self):
        for i in range(3):
            self.acquire(i)
        self.clock.now += self.config.ttl_seconds + 1
        grant = self.acquire(3)
        self.assertTrue(grant.slot_id.startswith("slot-"))

    def test_heartbeat_extends_only_own_slot(self):
        grant = self.acquire(0)
        mine = key_for(self.config, "user01@contoso.com", BROWSER_IDS[0])
        other = key_for(self.config, "user01@contoso.com", BROWSER_IDS[1])
        self.clock.now += 100
        extended = self.store.extend(grant.slot_id, mine)
        self.assertEqual(extended.expires_at, self.clock.now + self.config.ttl_seconds)
        self.assertIsNone(self.store.extend(grant.slot_id, other))

    def test_heartbeat_after_reassignment_fails(self):
        grant = self.acquire(0)
        self.clock.now += self.config.ttl_seconds + 1
        for i in range(1, 4):
            self.acquire(i)  # one of these takes over the expired slot
        mine = key_for(self.config, "user01@contoso.com", BROWSER_IDS[0])
        self.assertIsNone(self.store.extend(grant.slot_id, mine))

    def test_release_frees_slot(self):
        grants = [self.acquire(i) for i in range(3)]
        key0 = key_for(self.config, "user01@contoso.com", BROWSER_IDS[0])
        self.assertTrue(self.store.release(grants[0].slot_id, key0))
        self.acquire(3)  # succeeds after release

    def test_other_user_cannot_use_same_browser_id(self):
        grant = self.acquire(0, user="user01@contoso.com")
        hijack = key_for(self.config, "user02@contoso.com", BROWSER_IDS[0])
        self.assertIsNone(self.store.extend(grant.slot_id, hijack))
        self.assertFalse(self.store.release(grant.slot_id, hijack))

    def test_user_mode_counts_one_per_user(self):
        config = make_config(count_mode="user")
        store = SessionStore(config, self.repo, clock=self.clock)
        a = store.acquire(make_session_key(config, "user01@contoso.com", None), "user01@contoso.com")
        b = store.acquire(make_session_key(config, "USER01@contoso.com", None), "user01@contoso.com")
        self.assertEqual(a.slot_id, b.slot_id)

    def test_reducing_max_sessions_rejects_heartbeat_on_removed_slot(self):
        grants = [self.acquire(i) for i in range(3)]
        reduced = SessionStore(make_config(max_sessions=2), self.repo, clock=self.clock)
        last = max(grants, key=lambda g: g.slot_id)
        owner = next(i for i, g in enumerate(grants) if g.slot_id == last.slot_id)
        key = key_for(self.config, "user01@contoso.com", BROWSER_IDS[owner])
        self.assertIsNone(reduced.extend(last.slot_id, key))
        self.assertEqual(reduced.status()["activeSessions"], 2)

    def test_invalid_input_is_rejected(self):
        with self.assertRaises(InvalidSessionRequest):
            make_session_key(self.config, "user01@contoso.com", "bad id'; DROP")
        self.assertIsNone(self.store.extend("slot-0001' OR 1=1", "abc"))

    def test_validate_checks_ownership_expiry_and_limit_without_writes(self):
        grant = self.acquire(0)
        key = key_for(self.config, "user01@contoso.com", BROWSER_IDS[0])
        before = {name: dict(slot) for name, slot in self.repo.slots.items()}
        with patch.object(self.repo, "update_if_owner", side_effect=AssertionError("validate wrote")), \
             patch.object(self.repo, "claim", side_effect=AssertionError("validate claimed")), \
             patch.object(self.repo, "create_slot", side_effect=AssertionError("validate created")):
            self.assertEqual(self.store.validate(grant.slot_id, key), grant)
            self.assertIsNone(self.store.validate(grant.slot_id, "another-key"))
            self.assertIsNone(self.store.validate("slot-9998", key))
            self.assertIsNone(self.store.validate("bad-slot", key))
            self.assertIsNone(self.store.validate(None, key))
            reduced = SessionStore(make_config(max_sessions=1), self.repo, clock=self.clock)
            self.assertIsNone(reduced.validate("slot-0002", key))
            self.clock.now = grant.expires_at
            self.assertIsNone(self.store.validate(grant.slot_id, key))
        self.assertEqual(before, self.repo.slots)

    def test_validate_missing_slot(self):
        self.assertIsNone(self.store.validate("slot-0000", "key"))

    def test_concurrent_acquire_never_exceeds_limit(self):
        config = make_config(max_sessions=10)
        repo = InMemorySlotRepository()
        store = SessionStore(config, repo, clock=self.clock)
        results, errors = [], []
        barrier = threading.Barrier(60)

        def worker(i):
            barrier.wait()
            try:
                results.append(store.acquire(key_for(config, f"user{i}@contoso.com", BROWSER_IDS[i]), f"user{i}"))
            except SessionLimitReached:
                errors.append(i)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(60)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        slot_ids = [r.slot_id for r in results]
        self.assertEqual(len(slot_ids), len(set(slot_ids)), "a slot was granted twice")
        self.assertLessEqual(len(results), 10)
        self.assertEqual(store.status()["activeSessions"], len(results))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        for name in list(os.environ):
            if name.startswith("SESSION_"):
                del os.environ[name]

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_ttl_is_raised_when_shorter_than_two_heartbeats(self):
        os.environ["SESSION_HEARTBEAT_MODE"] = "interval"
        os.environ["SESSION_HEARTBEAT_INTERVAL_SECONDS"] = "300"
        os.environ["SESSION_TTL_SECONDS"] = "400"
        self.assertEqual(load_session_config().ttl_seconds, 900)

    def test_defaults(self):
        for name in list(os.environ):
            if name.startswith("SESSION_"):
                del os.environ[name]
        cfg = load_session_config()
        self.assertFalse(cfg.enabled)
        self.assertEqual((cfg.heartbeat_interval_seconds, cfg.ttl_seconds, cfg.max_sessions), (300, 900, 30))
        self.assertEqual(
            (cfg.heartbeat_mode, cfg.activity_check_seconds, cfg.idle_timeout_seconds, cfg.warning_seconds),
            ("activity", 600, 600, 60),
        )
        self.assertFalse(cfg.api_extends_session)
        self.assertFalse(cfg.fail_open)
        self.assertEqual(cfg.renewal_margin_seconds, 120)

    def test_activity_ranges_and_ttl_minimum(self):
        for values, expected in (
            (("1", "1", "1"), (60, 60, 10, 180)),
            (("99999", "999999", "9999"), (3600, 86400, 600, 720)),
            (("60", "60", "20"), (60, 60, 20, 180)),
            (("1200", "600", "60"), (1200, 600, 60, 180)),
        ):
            with self.subTest(values=values):
                os.environ.update(dict(zip(
                    ("SESSION_ACTIVITY_CHECK_SECONDS", "SESSION_IDLE_TIMEOUT_SECONDS", "SESSION_WARNING_SECONDS"),
                    values,
                )))
                os.environ["SESSION_TTL_SECONDS"] = "60"
                cfg = load_session_config()
                self.assertEqual(
                    (cfg.activity_check_seconds, cfg.idle_timeout_seconds, cfg.warning_seconds, cfg.ttl_seconds),
                    expected,
                )

    def test_renewal_margin_is_clamped_and_keeps_warning_and_ttl_safe(self):
        for raw, expected in (("1", 120), ("9999", 3600), ("bad", 120)):
            with self.subTest(raw=raw):
                os.environ["SESSION_RENEWAL_MARGIN_SECONDS"] = raw
                os.environ["SESSION_TTL_SECONDS"] = "60"
                cfg = load_session_config()
                self.assertEqual(cfg.renewal_margin_seconds, expected)
                self.assertEqual(cfg.ttl_seconds, expected + 60)
        os.environ["SESSION_RENEWAL_MARGIN_SECONDS"] = "80"
        os.environ["SESSION_WARNING_SECONDS"] = "20"
        os.environ["SESSION_TTL_SECONDS"] = "180"
        cfg = load_session_config()
        self.assertEqual((cfg.renewal_margin_seconds, cfg.ttl_seconds), (80, 180))

    def test_invalid_mode_logs_and_uses_activity(self):
        os.environ["SESSION_HEARTBEAT_MODE"] = "invalid"
        with self.assertLogs("shared.session_store", level="WARNING"):
            self.assertEqual(load_session_config().heartbeat_mode, "activity")

    def test_client_fields_and_boolean_settings(self):
        os.environ["SESSION_API_EXTEND"] = "true"
        os.environ["SESSION_FAIL_OPEN"] = "yes"
        cfg = load_session_config()
        self.assertTrue(cfg.api_extends_session)
        self.assertTrue(cfg.fail_open)
        self.assertEqual(
            {key: cfg.to_client_dict()[key] for key in
             ("heartbeatMode", "activityCheckSeconds", "idleTimeoutSeconds", "warningSeconds", "renewalMarginSeconds")},
            {"heartbeatMode": "activity", "activityCheckSeconds": 600, "idleTimeoutSeconds": 600,
             "warningSeconds": 60, "renewalMarginSeconds": 120},
        )


class CosmosReadTests(unittest.TestCase):
    def test_point_read_and_not_found(self):
        container = Mock()
        repo = CosmosSlotRepository(container, "company-a")
        container.read_item.return_value = {"id": "slot-0000"}
        self.assertEqual(repo.read_slot("slot-0000"), {"id": "slot-0000"})
        container.read_item.assert_called_once_with(item="slot-0000", partition_key="company-a")
        for status in (404, 429):
            error = RuntimeError("store failure")
            error.status_code = status
            container.read_item.side_effect = error
            if status == 404:
                self.assertIsNone(repo.read_slot("slot-0000"))
            else:
                with self.assertRaises(RuntimeError):
                    repo.read_slot("slot-0000")


if __name__ == "__main__":
    unittest.main()
