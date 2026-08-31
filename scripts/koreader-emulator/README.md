# KOReader Linux emulator UI harness

This harness runs the official KOReader Linux build in its SDL emulator under Xvfb, loads the working tree's `bookorbit.koplugin`, drives it with `xdotool`, and saves real screenshots. It exercises KOReader's actual widgets, focus system, plugin loader, screen scaling, network client, and rendering stack rather than a browser approximation.

The pinned upstream build is KOReader `v2026.07.1`. `run.sh` downloads the official x86_64 Linux archive and verifies its published SHA-256 before extracting it beneath `~/.cache/bookorbit-koreader-emulator/`.

## Requirements

- Docker
- Network access on the first run
- BookOrbit KOReader credentials for live-server checks

No host X server, FUSE, desktop session, or KOReader source build is required.

## Deterministic Store UI

The bundled fixture server advertises `catalogStore` and supplies stable Store books without touching a live library:

```bash
KOREADER_EMULATOR_USE_MOCK=1 \
KOREADER_EMULATOR_SCENARIO=store-home \
scripts/koreader-emulator/run.sh
```

Useful scenarios:

- `idle`: wait for the auto-opened BookOrbit dashboard
- `bookorbit-menu`: open the BookOrbit action menu
- `store-home`: open the native Store
- `store-detail`: open the first external book's action sheet
- `focus-tour`: move focus with the keyboard and activate the selected control
- `open-menu`: send KOReader's desktop menu key

Use an isolated output/profile when testing several dimensions:

```bash
KOREADER_EMULATOR_USE_MOCK=1 \
KOREADER_EMULATOR_OUTPUT="$PWD/.hermes/koreader-emulator-600" \
KOREADER_EMULATOR_PROFILE="$PWD/.hermes/koreader-emulator-600/profile" \
KOREADER_EMULATOR_WIDTH=600 \
KOREADER_EMULATOR_HEIGHT=800 \
KOREADER_EMULATOR_DPI=300 \
KOREADER_EMULATOR_SCENARIO=store-detail \
scripts/koreader-emulator/run.sh
```

Screenshots and logs land in the selected output directory. The mock request log proves which Store route the UI reached.

## Live BookOrbit

Set the KOReader API base and KOReader credential. Pass the MD5 user key expected by kosync, not a web JWT:

```bash
export BOOKORBIT_SERVER_URL='https://example.test/api/v1'
export BOOKORBIT_USERNAME='<koreader username>'
export BOOKORBIT_USERKEY='<md5 of koreader password>'
export KOREADER_EMULATOR_SCENARIO=idle
scripts/koreader-emulator/run.sh
```

The profile is isolated from any real device settings. The harness copies the plugin into that profile on every run, so source changes are picked up without mutating the downloaded KOReader installation.

## Adding a scenario

Add deterministic `xdotool` actions to `drive.py`. Prefer proportional coordinates derived from `KOREADER_EMULATOR_WIDTH` and `KOREADER_EMULATOR_HEIGHT`, and leave a pause after network-backed navigation. A scenario should produce both:

1. A screenshot showing the expected screen.
2. A fixture or live-server request-log marker proving the intended route executed.

Run `scripts/verify-koreader-emulator.sh` after changing the harness.

## What this proves

- Plugin packaging/loadability in a real KOReader runtime
- Lua/widget compatibility with the current official KOReader release
- Actual SDL layout at e-reader dimensions and DPI
- Touch-equivalent mouse input and keyboard/D-pad focus behavior
- Real network calls and response mapping
- Screen captures suitable for visual review and regression evidence

## What it does not prove

The desktop emulator cannot reproduce physical e-ink refresh artifacts, device-specific frontlight/buttons, Android storage permissions, suspend/resume behavior, or performance on constrained hardware. Final release verification should still include one physical KOReader device, but the emulator catches most layout, navigation, runtime, and integration failures before that step.
