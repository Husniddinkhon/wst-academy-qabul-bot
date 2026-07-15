from pathlib import Path
import sys
from PIL import Image


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check-render.py <png> <expected-size>")
    source = Path(sys.argv[1])
    expected_size = int(sys.argv[2])
    image = Image.open(source).convert("RGB")
    if image.size != (expected_size, expected_size):
        raise SystemExit(f"wrong dimensions: {image.size}")
    small = image.resize((54, 54))
    samples = [small.getpixel((x, y)) for y in range(54) for x in range(54)]
    blackish = sum(1 for red, green, blue in samples if red < 4 and green < 4 and blue < 4)
    if blackish:
        raise SystemExit(f"render contains {blackish}/2916 black compositor samples")
    top_left = image.getpixel((10, 10))
    if top_left != (7, 22, 45):
        raise SystemExit(f"unexpected top-left background pixel: {top_left}")
    image.verify()


if __name__ == "__main__":
    main()
