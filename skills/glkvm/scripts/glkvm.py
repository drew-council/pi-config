#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "click>=8.3.1",
#     "httpx>=0.28.1",
# ]
# ///

"""Deterministic CLI for the configured GLKVM."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import click
import httpx

BASE_URL = "https://kvm.home.drewcouncil.com"
CLI_PATH = "{{skillDir}}/scripts/glkvm.py"
SECRETS_FILE = Path.home() / ".pi" / "secrets" / "personal.json"
STATE_DIR = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/glkvm-{os.getuid()}")) / "pi-glkvm"
COOKIE_FILE = STATE_DIR / "cookies.json"
DEFAULT_SNAPSHOT = Path("/tmp/glkvm_snapshot.jpg")


def fail(message: str) -> None:
    raise click.ClickException(message)


def load_cookies() -> dict[str, str]:
    if not COOKIE_FILE.exists():
        fail(f"Not logged in. Run `{CLI_PATH} login`.")
    try:
        return json.loads(COOKIE_FILE.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Cannot read session cookies: {exc}")


def save_cookies(cookies: httpx.Cookies) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    values = {cookie.name: cookie.value for cookie in cookies.jar}
    COOKIE_FILE.write_text(json.dumps(values))
    os.chmod(COOKIE_FILE, 0o600)


def client(*, authenticated: bool = True) -> httpx.Client:
    cookies = load_cookies() if authenticated else None
    return httpx.Client(base_url=BASE_URL, verify=False, cookies=cookies, timeout=30.0)


def request(method: str, path: str, **kwargs: Any) -> httpx.Response:
    try:
        with client() as session:
            response = session.request(method, path, **kwargs)
    except httpx.HTTPError as exc:
        fail(f"GLKVM request failed: {exc}")
    if response.status_code in (401, 403):
        fail(f"GLKVM session expired. Run `{CLI_PATH} login`.")
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = response.text[:500]
        fail(f"GLKVM returned HTTP {response.status_code}: {detail or exc}")
    return response


def emit(response: httpx.Response) -> None:
    try:
        click.echo(json.dumps(response.json(), indent=2))
    except (json.JSONDecodeError, UnicodeDecodeError):
        click.echo(response.text)


def load_credentials() -> tuple[str, str]:
    """Read GLKVM credentials from the generated personal secret file."""
    try:
        glkvm = json.loads(SECRETS_FILE.read_text())["glkvm"]
        username = glkvm.get("username") or "admin"
        password = glkvm["password"]
    except (OSError, json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
        fail(f"Cannot read GLKVM credentials from {SECRETS_FILE}: {exc}")
    if not password:
        fail(f"The GLKVM password in {SECRETS_FILE} must not be empty.")
    return str(username), str(password)


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
def cli() -> None:
    """Control the GLKVM at kvm.home.drewcouncil.com."""


@cli.command()
def login() -> None:
    """Log in with the configured credentials and cache session cookies."""
    username, password = load_credentials()
    try:
        with client(authenticated=False) as session:
            response = session.post("/api/auth/login", data={"user": username, "passwd": password})
            response.raise_for_status()
            payload = response.json()
            if not payload.get("ok", False):
                fail(f"Login was not accepted: {json.dumps(payload)}")
            save_cookies(session.cookies)
    except httpx.HTTPError as exc:
        fail(f"GLKVM login failed: {exc}")
    click.echo(f"Logged in; session cookies cached at {COOKIE_FILE}")


@cli.command()
def logout() -> None:
    """Delete locally cached session cookies."""
    COOKIE_FILE.unlink(missing_ok=True)
    click.echo("Cached GLKVM session removed.")


@cli.command()
def status() -> None:
    """Show keyboard/mouse status."""
    emit(request("GET", "/api/hid"))


@cli.command()
@click.option("--output", type=click.Path(path_type=Path), default=DEFAULT_SNAPSHOT, show_default=True)
@click.option("--full", is_flag=True, help="Capture full quality instead of a 1280x720 preview.")
@click.option("--ocr", is_flag=True, help="Return English OCR JSON instead of writing an image.")
def snapshot(output: Path, full: bool, ocr: bool) -> None:
    """Capture the current screen."""
    if ocr:
        emit(request("GET", "/api/streamer/snapshot", params={"ocr": "true", "ocr_langs": "chi_sim,eng"}))
        return
    params = (
        {}
        if full
        else {
            "preview": "true",
            "preview_max_width": 1280,
            "preview_max_height": 720,
            "preview_quality": 80,
        }
    )
    response = request("GET", "/api/streamer/snapshot", params=params)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(response.content)
    click.echo(str(output))


@cli.command("key")
@click.argument("name")
@click.option("--state", type=click.Choice(["press", "release"]), help="Omit for press+release.")
def send_key(name: str, state: str | None) -> None:
    """Send one USB HID key, e.g. KEY_ENTER or KEY_A."""
    params: dict[str, str] = {"key": name.upper()}
    if state:
        params["state"] = "true" if state == "press" else "false"
    emit(request("POST", "/api/hid/events/send_key", params=params))


@cli.command()
@click.argument("keys")
def shortcut(keys: str) -> None:
    """Send comma-separated KeyboardEvent codes, e.g. ControlLeft,KeyC."""
    emit(request("POST", "/api/hid/events/send_shortcut", params={"keys": keys}))


@cli.command("type")
@click.argument("text")
@click.option("--slow", is_flag=True, help="Add a delay between keystrokes.")
def type_text(text: str, slow: bool) -> None:
    """Type literal text through the KVM keyboard."""
    emit(
        request(
            "POST",
            "/api/hid/print",
            params={"slow": str(slow).lower()},
            content=text,
            headers={"Content-Type": "text/plain"},
        )
    )


@cli.command()
def reset() -> None:
    """Release all HID keys/buttons if input is stuck."""
    emit(request("POST", "/api/hid/reset"))


@cli.command("move")
@click.argument("x", type=click.IntRange(-32768, 32767))
@click.argument("y", type=click.IntRange(-32768, 32767))
def mouse_move(x: int, y: int) -> None:
    """Move to absolute HID coordinates (-32768..32767)."""
    emit(request("POST", "/api/hid/events/send_mouse_move", params={"to_x": x, "to_y": y}))


@cli.command("move-pixel")
@click.argument("x", type=click.IntRange(min=0))
@click.argument("y", type=click.IntRange(min=0))
@click.option("--width", required=True, type=click.IntRange(min=1))
@click.option("--height", required=True, type=click.IntRange(min=1))
def mouse_move_pixel(x: int, y: int, width: int, height: int) -> None:
    """Move to pixel X,Y given the screenshot dimensions."""
    if x >= width or y >= height:
        fail("Pixel coordinates must be inside the supplied dimensions.")
    to_x = round(x / width * 65535 - 32768)
    to_y = round(y / height * 65535 - 32768)
    emit(request("POST", "/api/hid/events/send_mouse_move", params={"to_x": to_x, "to_y": to_y}))


@cli.command("relative")
@click.argument("dx", type=click.IntRange(-127, 127))
@click.argument("dy", type=click.IntRange(-127, 127))
def mouse_relative(dx: int, dy: int) -> None:
    """Move the mouse relatively by -127..127 per axis."""
    emit(request("POST", "/api/hid/events/send_mouse_relative", params={"delta_x": dx, "delta_y": dy}))


@cli.command("click")
@click.option("--button", type=click.Choice(["left", "right", "middle"]), default="left", show_default=True)
@click.option("--state", type=click.Choice(["press", "release"]), help="Omit for a complete click.")
def mouse_click(button: str, state: str | None) -> None:
    """Click, press, or release a mouse button at its current position."""
    params: dict[str, str] = {"button": button}
    if state:
        params["state"] = "true" if state == "press" else "false"
    emit(request("POST", "/api/hid/events/send_mouse_button", params=params))


@cli.command()
@click.argument("dy", type=click.IntRange(-127, 127))
@click.option("--dx", type=click.IntRange(-127, 127), default=0, show_default=True)
def scroll(dy: int, dx: int) -> None:
    """Scroll; positive DY is up and negative is down."""
    emit(request("POST", "/api/hid/events/send_mouse_wheel", params={"delta_x": dx, "delta_y": dy}))


@cli.group()
def fingerbot() -> None:
    """Inspect or press the physical Fingerbot."""


@fingerbot.command("status")
def fingerbot_status() -> None:
    """Show Fingerbot existence and battery."""
    emit(request("GET", "/api/fingerbot/exist"))
    emit(request("GET", "/api/fingerbot/battery"))


@fingerbot.command("press")
@click.option("--milliseconds", type=click.IntRange(100, 60000), required=True)
@click.option("--angle", type=click.Choice(["1", "2"]), default="2", show_default=True)
@click.confirmation_option(prompt="This physically presses the PC button. Continue?")
def fingerbot_press(milliseconds: int, angle: str) -> None:
    """Physically press the configured PC button (interactive confirmation required)."""
    emit(request("GET", "/api/fingerbot/click", params={"press_time": milliseconds, "angle_enum": angle}))


if __name__ == "__main__":
    cli()
