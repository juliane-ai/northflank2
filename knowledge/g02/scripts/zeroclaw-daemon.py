#!/usr/bin/env python3
"""Route chat images to the configured vision service, then replace this process."""
import os
import re
import sys
from urllib.parse import urlsplit


RELAY = "ZEROCLAW_providers__models__custom__relay__"
VISION = "ZEROCLAW_providers__models__custom__vision__"
ROUTE = "ZEROCLAW_multimodal__vision_model_provider"
ROUTE_MODEL = "ZEROCLAW_multimodal__vision_model"
DEFAULT_MODEL = "models/gemini-2.5-flash"
LOCAL_RELAY_PATH = "/internal/vision/v1"
LOCAL_TEXT_RELAY_PATH = "/internal/relay/v1"
RELAY_ROUTE = "ZEROCLAW_RELAY_ROUTE"
LIMITS = {"max_images": "3", "max_image_size_mb": "8", "max_image_turns": "1"}


class ConfigurationError(ValueError):
    """Safe operator message; never include the original configuration value."""


def normalized_url(value):
    try:
        if not value or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or "?" in value or "#" in value
                or "\\" in value or "%" in parsed.netloc
                or parsed.path not in ("", "/", "/v1", "/v1/")
                or not re.fullmatch(r"[A-Za-z0-9.:[\]-]+", parsed.netloc)):
            raise ValueError()
        # Accessing port also validates malformed or out-of-range ports.
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
        return "https://" + parsed.netloc + "/v1"
    except (TypeError, ValueError):
        raise ConfigurationError("Vision URL must be an HTTPS origin or /v1 endpoint without credentials, query, or fragment") from None


def local_relay_url(env, path):
    """Loopback retry endpoint served by the dashboard process in this container."""
    candidates = [str(env.get("PORT") or "").strip(), str(env.get("OKX_VIEWER_PORT") or "").strip()]
    port = next((value for value in candidates if value), "8080")
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        raise ConfigurationError("Dashboard port is invalid for the local retry relay")
    return "http://127.0.0.1:" + str(int(port)) + path


def redirect_text_alias(prepared):
    """Point a fully configured text alias at the loopback retry relay.

    Only an alias that already looks like the upstream relay (HTTPS origin or
    /v1 endpoint) is redirected; anything else the operator configured — for
    example an in-cluster HTTP service or an already redirected value — is
    left untouched instead of being rejected.
    """
    if not all(prepared.get(RELAY + field) for field in ("uri", "api_key", "model")):
        return
    try:
        normalized_url(prepared[RELAY + "uri"])
    except ConfigurationError:
        return
    try:
        validate_key(prepared[RELAY + "api_key"])
        validate_model(prepared[RELAY + "model"])
    except ConfigurationError:
        return
    prepared[RELAY + "uri"] = local_relay_url(prepared, LOCAL_TEXT_RELAY_PATH)


def validate_key(value):
    if not value or not value.strip() or len(value) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ConfigurationError("Vision API key is missing or invalid")
    return value


def validate_model(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_.:-]{0,199}", value or ""):
        raise ConfigurationError("Vision model identifier is invalid")
    return value


def prepare_environment(env):
    """Return a copy with defaults; never combine explicit alias credentials."""
    prepared = dict(env)
    relay_model = prepared.get(RELAY + "model", "")
    if re.match(r"^(?:nvidia/)?nemotron-3-(?:super|ultra)(?:-|$)", relay_model, re.I):
        prepared.setdefault(RELAY + "vision", "false")

    # 上游中转会随机返回 403/5xx，而 ZeroClaw 的视觉与文字 relay 都不重试；
    # 默认把两个 alias 都改道同容器主服务暴露的回环重试端点，"direct" 可恢复直连。
    relay_route = str(prepared.get(RELAY_ROUTE, "local")).strip().lower()
    if relay_route not in ("local", "direct"):
        raise ConfigurationError("ZEROCLAW_RELAY_ROUTE must be local or direct")
    if relay_route == "local":
        redirect_text_alias(prepared)

    # An operator-provided route is authoritative, including an empty value.
    # Its provider may be native Gemini or another fully configured alias.
    if ROUTE in prepared or ROUTE_MODEL in prepared:
        if prepared.get(ROUTE):
            for key, value in LIMITS.items():
                prepared.setdefault("ZEROCLAW_multimodal__" + key, value)
        return prepared

    alias_present = any(key.startswith(VISION) for key in prepared)
    if alias_present:
        # A partial custom alias must be completed by its owner. In particular,
        # never attach the SIGNAL API key to an independently configured URL.
        if not all(prepared.get(VISION + key) for key in ("uri", "api_key", "model")):
            return prepared
        uri = normalized_url(prepared[VISION + "uri"])
        key = validate_key(prepared[VISION + "api_key"])
        model = validate_model(prepared[VISION + "model"])
    else:
        url, key = prepared.get("SIGNAL_VISION_BASE_URL"), prepared.get("SIGNAL_VISION_API_KEY")
        if not url or not key:
            return prepared
        uri = normalized_url(url)
        key = validate_key(key)
        models = prepared.get("SIGNAL_VISION_MODELS", "").split(",")
        model = validate_model(prepared.get("ZEROCLAW_VISION_MODEL") or models[0].strip() or DEFAULT_MODEL)
        if relay_route == "local":
            uri = local_relay_url(prepared, LOCAL_RELAY_PATH)
            # The loopback relay authenticates callers with its own token when
            # configured, so the alias key must match it instead of the upstream key.
            proxy_token = prepared.get("SIGNAL_VISION_PROXY_TOKEN")
            if proxy_token:
                key = validate_key(proxy_token)

    prepared.setdefault(VISION + "uri", uri)
    prepared.setdefault(VISION + "api_key", key)
    prepared.setdefault(VISION + "model", model)
    prepared.setdefault(VISION + "vision", "true")
    # An explicit vision=false alias cannot be used as an automatic vision route.
    if prepared[VISION + "vision"].lower() != "true":
        return prepared
    prepared[ROUTE] = "custom.vision"
    prepared[ROUTE_MODEL] = model
    for key, value in LIMITS.items():
        prepared.setdefault("ZEROCLAW_multimodal__" + key, value)
    return prepared


def main(env=None):
    original = dict(os.environ if env is None else env)
    try:
        prepared = prepare_environment(original)
    except ConfigurationError as error:
        print("ZeroClaw vision configuration rejected: " + str(error), file=sys.stderr, flush=True)
        return 1
    if prepared.get(ROUTE):
        target = "local retry relay" if prepared[VISION + "uri"].startswith("http://127.0.0.1:") else "direct vision endpoint"
        print("ZeroClaw image routing enabled via " + target + "; text model unchanged", flush=True)
    elif (original.get("SIGNAL_VISION_BASE_URL") or original.get("SIGNAL_VISION_API_KEY")
          or any(key.startswith(VISION) for key in original)):
        print("WARNING: ZeroClaw image routing not configured; complete the vision settings or explicit provider route", file=sys.stderr, flush=True)
    elif prepared.get(RELAY + "vision") == "false":
        print("ZeroClaw text-only relay configured; set SIGNAL_VISION_BASE_URL and SIGNAL_VISION_API_KEY for chat images", flush=True)
    # Keep entrypoint supervision and signal delivery attached to ZeroClaw's
    # actual PID. This launcher is not a resident sidecar.
    try:
        os.execvpe("zeroclaw", ["zeroclaw", "daemon"], prepared)
    except OSError:
        print("ZeroClaw daemon could not be started", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
