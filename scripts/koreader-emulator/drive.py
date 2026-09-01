#!/usr/bin/env python3
"""Small xdotool driver for repeatable KOReader emulator interactions."""

from __future__ import annotations

import argparse
import os
import subprocess
import time


def run(*args: str) -> None:
    subprocess.run(["xdotool", *args], check=True)


def key(name: str, pause: float = 0.35) -> None:
    run("key", "--clearmodifiers", name)
    time.sleep(pause)


def click(x: int, y: int, pause: float = 0.5) -> None:
    run("mousemove", str(x), str(y), "click", "1")
    time.sleep(pause)


def open_dashboard_menu() -> None:
    if os.environ.get("DISABLE_TOUCH") == "1":
        key("Return", pause=0.5)
        key("Up", pause=0.1)
        key("Up", pause=0.1)
        key("Return", pause=0.75)
        return
    click(30, 32, pause=0.75)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "scenario",
        choices=["idle", "focus-tour", "open-menu", "bookorbit-menu", "store-home", "store-detail", "store-acquire"],
    )
    parser.add_argument("--wait", type=float, default=4.0)
    args = parser.parse_args()
    time.sleep(args.wait)

    if args.scenario == "idle":
        return
    if args.scenario == "focus-tour":
        for _ in range(4):
            key("Tab")
        key("Return")
        return
    if args.scenario == "open-menu":
        # KOReader's desktop emulator maps Menu/F1 to the main menu.
        key("F1")
        return
    if args.scenario == "bookorbit-menu":
        open_dashboard_menu()
        return
    if args.scenario == "store-home":
        width = int(os.environ.get("KOREADER_EMULATOR_WIDTH", "758"))
        height = int(os.environ.get("KOREADER_EMULATOR_HEIGHT", "1024"))
        open_dashboard_menu()
        if os.environ.get("DISABLE_TOUCH") == "1":
            key("Up")
            key("Return", pause=3.0)
        else:
            click(round(width * 0.50), round(height * 0.161), pause=3.0)
        return
    if args.scenario == "store-detail":
        width = int(os.environ.get("KOREADER_EMULATOR_WIDTH", "758"))
        height = int(os.environ.get("KOREADER_EMULATOR_HEIGHT", "1024"))
        click(round(width * 0.04), round(height * 0.031))
        click(round(width * 0.50), round(height * 0.161), pause=3.0)
        click(round(width * 0.17), round(height * 0.27), pause=2.0)
        return
    if args.scenario == "store-acquire":
        width = int(os.environ.get("KOREADER_EMULATOR_WIDTH", "758"))
        height = int(os.environ.get("KOREADER_EMULATOR_HEIGHT", "1024"))
        click(round(width * 0.04), round(height * 0.031))
        click(round(width * 0.50), round(height * 0.161), pause=3.0)
        click(round(width * 0.17), round(height * 0.27), pause=1.0)
        click(round(width * 0.25), round(height * 0.35), pause=2.0)
        return


if __name__ == "__main__":
    main()
