"""Deterministic approved-contact-sheet crop. Root runs and reviews this script.

Requires the existing Pillow installation; installs nothing, contacts nothing.
The output is a static portrait, not a rig, sprite sheet or animation.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".design/asael-ace-revamp/references/atlas-selected.png"
OUTPUT = ROOT / "public/companion/atlas-neutral.png"
SOURCE_SHA256 = "876591c5a2b739df99d6aab647554dc53bcab97d55bf0c3e0864e39e1c98c070"
BOUNDS = (350, 830, 650, 1190)


def main():
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise SystemExit("Approved source checksum differs; stop for review.")
    with Image.open(SOURCE) as source:
        if source.size != (2560, 2256):
            raise SystemExit("Approved source dimensions differ; stop for review.")
        portrait = source.convert("RGB").crop(BOUNDS)
        # Preserve the complete 300x360 crop inside a square 3x display asset.
        portrait = portrait.resize((90, 108), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (108, 108), portrait.getpixel((0, 0)))
        canvas.paste(portrait, (9, 0))
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(OUTPUT, format="PNG", optimize=False, compress_level=9)
    provenance = {
        "source": ".design/asael-ace-revamp/references/atlas-selected.png",
        "sourceProvenance": ".design/asael-ace-revamp/references/atlas-export.json",
        "sourceSha256": SOURCE_SHA256,
        "cropPixels": {"left": BOUNDS[0], "top": BOUNDS[1], "right": BOUNDS[2], "bottom": BOUNDS[3]},
        "outputPixels": [108, 108], "displayPixels": [36, 36],
        "outputSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
        "method": "RGB crop, Lanczos resize 90x108, centered 9px horizontal padding sampled from crop top-left; PNG compression9",
        "kind": "Static neutral head and neck from approved contact sheet; no model, rig, animation or additional pose",
        "reviewRequired": "Inspect crop at native and 36px display size before release.",
    }
    OUTPUT.with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(OUTPUT)


if __name__ == "__main__":
    main()
