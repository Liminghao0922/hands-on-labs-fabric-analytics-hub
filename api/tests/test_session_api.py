"""HTTP session controls with a failing repository; no Azure resources required."""

import json
import unittest
from unittest.mock import Mock, patch

import azure.functions as func

import session_api
from shared.session_store import InvalidSessionRequest, SessionGrant, SessionLimitReached, SessionStore
from test_session_store import BROWSER_IDS, FakeClock, InMemorySlotRepository, make_config


class SessionApiTests(unittest.TestCase):
    def request(self, body=None, headers=None):
        return func.HttpRequest(
            method="POST", url="https://localhost/api/session/acquire",
            headers=headers or {}, params={}, body=json.dumps(body or {}).encode(),
        )

    def setUp(self):
        self.config = make_config()
        self.repo = Mock(spec=InMemorySlotRepository)
        for operation in ("find_slot_by_key", "update_if_owner", "read_slot", "count_active"):
            getattr(self.repo, operation).side_effect = RuntimeError("store unavailable")
        self.store = SessionStore(self.config, self.repo, clock=FakeClock())
        self.config_patch = patch.object(session_api, "load_session_config", side_effect=lambda: self.config)
        self.store_patch = patch.object(session_api, "get_session_store", return_value=self.store)
        self.auth_patch = patch.object(session_api, "get_user_upn", return_value="user@contoso.com")
        for patcher in (self.config_patch, self.store_patch, self.auth_patch):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_endpoints_fail_open_only_on_service_error(self):
        for fail_open in (False, True):
            self.config = make_config(fail_open=fail_open)
            for name, endpoint in (("acquire", session_api.session_acquire), ("heartbeat", session_api.session_heartbeat)):
                with self.subTest(fail_open=fail_open, endpoint=name):
                    with self.assertLogs("session_api", level="WARNING") as logs:
                        res = endpoint(self.request({"browserId": BROWSER_IDS[0], "slotId": "slot-0000"}))
                    data = json.loads(res.get_body())
                    self.assertEqual(res.status_code, 200 if fail_open else 503)
                    self.assertEqual(res.headers["Cache-Control"], "no-store")
                    self.assertTrue(data["errorId"])
                    self.assertIn("errorId=", " ".join(logs.output))
                    if fail_open:
                        self.assertTrue(data["enabled"])
                        self.assertTrue(data["degraded"])
                        self.assertNotIn("slotId", data)
                        self.assertEqual(data["heartbeatMode"], "activity")

    def test_fail_open_does_not_bypass_invalid_requests_or_limits(self):
        self.config = make_config(fail_open=True)
        for browser in ("invalid!", {}, None):
            res = session_api.session_acquire(self.request({"browserId": browser}))
            self.assertEqual(res.status_code, 400)
        for error, expected in (
            (InvalidSessionRequest("invalid"), 400), (SessionLimitReached("full"), 409),
        ):
            self.repo.find_slot_by_key.side_effect = error
            res = session_api.session_acquire(self.request({"browserId": BROWSER_IDS[0]}))
            self.assertEqual(res.status_code, expected)
        res = session_api.session_heartbeat(self.request({"browserId": BROWSER_IDS[0], "slotId": {}}))
        self.assertEqual(res.status_code, 410)

    def test_guard_fail_open_and_fail_closed(self):
        handler = Mock(return_value=func.HttpResponse("ok"))
        handler.__name__ = "business"
        guarded = session_api.require_session(handler)
        for fail_open in (False, True):
            self.config = make_config(fail_open=fail_open)
            for slot in ("slot-0000", None):
                headers = {"x-session-browser": BROWSER_IDS[0]}
                if slot:
                    headers["x-session-slot"] = slot
                with self.subTest(fail_open=fail_open, slot=slot):
                    if not fail_open and slot is None:
                        res = guarded(self.request(headers=headers))
                    else:
                        with self.assertLogs("session_api", level="WARNING"):
                            res = guarded(self.request(headers=headers))
                    self.assertEqual(res.status_code, 200 if fail_open else (503 if slot else 410))
                    self.assertEqual(res.headers["Cache-Control"], "no-store")
                    if fail_open:
                        self.assertEqual(res.headers["X-Session-Extended"], "false")
        self.assertEqual(handler.call_count, 2)

    def test_guard_validates_or_extends_and_sets_headers(self):
        store = Mock()
        store.validate.return_value = store.extend.return_value = SessionGrant("slot-0000", 1234567)
        handler = Mock(return_value=func.HttpResponse("ok"))
        handler.__name__ = "business"
        with patch.object(session_api, "get_session_store", return_value=store):
            for extends in (False, True):
                self.config = make_config(api_extends_session=extends)
                res = session_api.require_session(handler)(self.request(headers={
                    "x-session-browser": BROWSER_IDS[0], "x-session-slot": "slot-0000",
                }))
                self.assertEqual(res.headers["X-Session-Expires-At"], "1234567")
                self.assertEqual(res.headers["X-Session-Extended"], str(extends).lower())
                self.assertEqual(res.headers["Cache-Control"], "no-store")
            self.assertEqual(store.validate.call_count, 1)
            self.assertEqual(store.extend.call_count, 1)
            self.config = make_config(fail_open=True)
            store.validate.return_value = None
            expired = session_api.require_session(handler)(self.request(headers={
                "x-session-browser": BROWSER_IDS[0], "x-session-slot": "slot-0000",
            }))
            self.assertEqual(expired.status_code, 410)
            self.assertEqual(expired.headers["Cache-Control"], "no-store")

    def test_release_reason_is_allowlisted(self):
        self.repo.update_if_owner.side_effect = None
        self.repo.update_if_owner.return_value = True
        for reason, expected in (("idle", "idle"), ("close", "close"), ("bad\nreason", "logout"), (None, "logout")):
            with self.assertLogs("session_api", level="INFO") as logs:
                res = session_api.session_release(self.request({
                    "browserId": BROWSER_IDS[0], "slotId": "slot-0000", "reason": reason,
                }))
            self.assertEqual(res.status_code, 204)
            self.assertIn(f"reason={expected}", " ".join(logs.output))

    def test_release_rejects_invalid_slot_without_calling_store(self):
        self.config = make_config(fail_open=True)
        for slot in ({}, [], 123, "", "slot-0000\n", "invalid-slot"):
            with self.subTest(slot=slot):
                res = session_api.session_release(self.request({
                    "browserId": BROWSER_IDS[0], "slotId": slot,
                }))
                self.assertEqual(res.status_code, 400)
                self.assertEqual(json.loads(res.get_body())["code"], "INVALID_SESSION_REQUEST")
        self.repo.update_if_owner.assert_not_called()
        self.repo.find_slot_by_key.assert_not_called()

    def test_release_can_find_slot_when_slot_id_is_omitted(self):
        store = Mock()
        with patch.object(session_api, "get_session_store", return_value=store):
            res = session_api.session_release(self.request({"browserId": BROWSER_IDS[0]}))
        self.assertEqual(res.status_code, 204)
        self.assertIsNone(store.release.call_args.args[0])

    def test_acquire_and_heartbeat_return_client_configuration(self):
        store = Mock()
        store.acquire.return_value = store.extend.return_value = SessionGrant("slot-0000", 1234567)
        with patch.object(session_api, "get_session_store", return_value=store):
            for endpoint in (session_api.session_acquire, session_api.session_heartbeat):
                res = endpoint(self.request({"browserId": BROWSER_IDS[0], "slotId": "slot-0000"}))
                data = json.loads(res.get_body())
                for key, value in self.config.to_client_dict().items():
                    self.assertEqual(data[key], value)
                self.assertEqual(data["slotId"], "slot-0000")
                self.assertEqual(data["expiresAt"], 1234567)
                self.assertEqual(res.headers["Cache-Control"], "no-store")
