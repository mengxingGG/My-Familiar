"""裁切 imagegen 家具精灵表，打包透明 PNG、锚点清单和人工检查预览。

只处理已有生成图，不调用图像 API。默认输入为本地忽略的美术工作目录；
可用 --source 指向另存的五张 atlas-<set>.png，不依赖外部图像服务。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CATALOG = [
    ("wood-bed", "warmwood", "暖木矮床", (2, 3), "sleep"),
    ("wood-table", "warmwood", "小圆桌", (2, 2), "surface"),
    ("wood-stool", "warmwood", "圆木凳", (1, 1), "sit"),
    ("wood-cabinet", "warmwood", "双门小柜", (2, 1), "storage"),
    ("wood-shelf", "warmwood", "矮书架", (2, 1), "shelf"),
    ("wood-rug", "warmwood", "编织地毯", (3, 2), "rug"),
    ("forest-bed", "forest", "蘑菇软床", (2, 3), "sleep"),
    ("forest-table", "forest", "树桩桌", (2, 2), "surface"),
    ("forest-chair", "forest", "叶片椅", (1, 1), "sit"),
    ("forest-cabinet", "forest", "树洞柜", (2, 1), "storage"),
    ("forest-lamp", "forest", "萤光灯", (1, 1), "lamp"),
    ("forest-rug", "forest", "苔藓地毯", (3, 2), "rug"),
    ("ocean-bed", "ocean", "贝壳床", (2, 3), "sleep"),
    ("ocean-table", "ocean", "潮汐桌", (2, 2), "surface"),
    ("ocean-stool", "ocean", "泡泡凳", (1, 1), "sit"),
    ("ocean-cabinet", "ocean", "漂流小柜", (2, 1), "storage"),
    ("ocean-lamp", "ocean", "水母灯", (1, 1), "lamp"),
    ("ocean-rug", "ocean", "浪纹地毯", (3, 2), "rug"),
    ("star-bed", "star", "星月小床", (2, 3), "sleep"),
    ("star-desk", "star", "阅读书桌", (2, 2), "surface"),
    ("star-chair", "star", "绒面软椅", (1, 1), "sit"),
    ("star-shelf", "star", "星空书柜", (2, 1), "shelf"),
    ("star-lamp", "star", "星灯", (1, 1), "lamp"),
    ("star-rug", "star", "星轨地毯", (3, 2), "rug"),
    ("food-basic", "daily", "基础口粮", (1, 1), "food"),
    ("food-fruit", "daily", "果盘", (1, 1), "food"),
    ("food-bento", "daily", "便当", (1, 1), "food"),
    ("food-dessert", "daily", "精致甜点", (1, 1), "food"),
    ("toy-ball", "daily", "小球", (1, 1), "toy"),
    ("toy-pinwheel", "daily", "纸风车", (1, 1), "toy"),
    ("toy-blocks", "daily", "小积木", (1, 1), "toy"),
    ("starter-bowl", "daily", "初始食盆", (1, 1), "feed"),
    ("starter-mat", "daily", "初始软垫", (2, 2), "sleep"),
    ("memorial-trophy", "daily", "成长纪念摆件", (1, 1), "decor"),
]


def components(image: Image.Image, expected: int) -> list[tuple[int, int, int, int]]:
    """按真实透明间隔寻找物件，避免生成图轻微偏离网格造成裁断。"""
    width, height = image.size
    mask = bytearray(image.getchannel("A").point(lambda a: 255 if a > 20 else 0).tobytes())
    found = []
    for start in range(width * height):
        if not mask[start]:
            continue
        mask[start] = 0
        pending = [start]
        size, left, top, right, bottom = 0, width, height, 0, 0
        while pending:
            at = pending.pop()
            y, x = divmod(at, width)
            size += 1
            left, right = min(left, x), max(right, x)
            top, bottom = min(top, y), max(bottom, y)
            for adjacent in (
                at - 1 if x else -1,
                at + 1 if x + 1 < width else -1,
                at - width if y else -1,
                at + width if y + 1 < height else -1,
            ):
                if adjacent >= 0 and mask[adjacent]:
                    mask[adjacent] = 0
                    pending.append(adjacent)
        if size > 1000:
            found.append((left, top, right + 1, bottom + 1))
    if len(found) != expected:
        raise ValueError(f"精灵表应有 {expected} 个独立物件，实际找到 {len(found)} 个，需人工检查")
    columns = 4 if expected == 10 else 3
    rows = 3 if expected == 10 else 2
    return sorted(found, key=lambda b: (int((b[1] + b[3]) / 2 / height * rows), (b[0] + b[2]) / 2))


def pack(source: Image.Image, bounds: tuple[int, int, int, int]) -> Image.Image:
    left, top, right, bottom = bounds
    part = source.crop((max(0, left - 4), max(0, top - 4), min(source.width, right + 4), min(source.height, bottom + 4)))
    # 清除透明抠图中肉眼不可见的 1–3/255 alpha 噪点；保留真实半透明材质和边缘。
    part.putalpha(part.getchannel("A").point(lambda a: 0 if a <= 3 else a))
    part.thumbnail((448, 432), Image.Resampling.LANCZOS)
    result = Image.new("RGBA", (512, 512))
    result.alpha_composite(part, ((512 - part.width) // 2, 480 - part.height))
    return result


def font(size: int) -> ImageFont.ImageFont:
    for path in (Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/simhei.ttf")):
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=root / ".artifacts/v2-art-room")
    parser.add_argument("--output", type=Path, default=root / "assets/life")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(root):
        raise ValueError("输出必须位于当前项目目录内")
    output.mkdir(parents=True, exist_ok=True)
    source_dir = args.source.resolve()
    records = []
    source_records = []
    for group in ("warmwood", "forest", "ocean", "star", "daily"):
        path = source_dir / f"atlas-{group}.png"
        atlas = Image.open(path).convert("RGBA")
        items = [item for item in CATALOG if item[1] == group]
        boxes = components(atlas, len(items))
        source_records.append({"atlas": path.name, "size": list(atlas.size), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        for item, bounds in zip(items, boxes, strict=True):
            asset_id, _, title, footprint, behavior = item
            image = pack(atlas, bounds)
            image.save(output / f"{asset_id}.png", optimize=True)
            rectangle = image.getchannel("A").point(lambda a: 255 if a > 20 else 0).getbbox()
            assert rectangle is not None
            record = {
                "id": asset_id, "name": title, "set": group,
                "file": f"{asset_id}.png", "size": [512, 512],
                "anchor": {"x": 0.5, "y": 0.9375},
                "footprint": {"width": footprint[0], "depth": footprint[1]},
                "rotations": [0], "view": "front-left", "behavior": behavior,
                "contentBounds": list(rectangle), "sourceAtlas": path.name, "sourceBounds": list(bounds),
                "interaction": {"x": 0.5, "y": 0.63 if behavior == "sleep" else 0.70},
            }
            if behavior in ("surface", "shelf", "storage"):
                surface_y = (rectangle[1] + (rectangle[3] - rectangle[1]) * (0.30 if behavior == "surface" else 0.12)) / 512
                record["placementSurface"] = {"x": 0.5, "y": round(surface_y, 4), "width": 0.55, "depth": 0.20}
            if asset_id.endswith("-bed"):
                # 从同一张床图分离近侧被褥/床框，保证前景材质与底图精确重合。
                foreground = Image.new("RGBA", image.size)
                cut = round(rectangle[1] + (rectangle[3] - rectangle[1]) * 0.69)
                foreground.alpha_composite(image.crop((0, cut, 512, 512)), (0, cut))
                foreground.save(output / f"{asset_id}-foreground.png", optimize=True)
                record["foreground"] = f"{asset_id}-foreground.png"
                record["foregroundCutY"] = cut / 512
            record["bytes"] = (output / record["file"]).stat().st_size
            record["sha256"] = hashlib.sha256((output / record["file"]).read_bytes()).hexdigest()
            records.append(record)

    manifest = {
        "manifestVersion": 1,
        "style": "Familiar cozy painted 2.5D",
        "canvas": {"width": 512, "height": 512},
        "view": {"name": "front-left", "rotation": 0, "approximateElevationDegrees": 30},
        "units": "Footprints use logical room cells; anchor and interaction coordinates are normalized to the complete PNG canvas.",
        "generation": {"method": "built-in imagegen", "date": "2026-11-02", "sources": source_records},
        "items": records,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 所有物件的编号预览用于检查裁切、色系与中文名称，预览不参与运行时打包。
    preview = Image.new("RGB", (1200, 6 * 250), "#f3ede2")
    draw = ImageDraw.Draw(preview)
    for index, item in enumerate(records):
        sprite = Image.open(output / item["file"])
        sprite.thumbnail((174, 194), Image.Resampling.LANCZOS)
        x, y = (index % 6) * 200, (index // 6) * 250
        preview.paste(sprite, (x + (200 - sprite.width) // 2, y), sprite)
        draw.text((x + 12, y + 198), item["name"], fill="#31443a", font=font(17))
        draw.text((x + 12, y + 224), item["id"], fill="#6c796e", font=font(11))
    preview.save(source_dir / "catalog-preview.jpg", quality=93)

    checked = []
    for item in records:
        image = Image.open(output / item["file"])
        assert image.mode == "RGBA" and image.size == (512, 512)
        extrema = image.getchannel("A").getextrema()
        assert extrema[0] == 0 and extrema[1] > 220
        left, top, right, bottom = item["contentBounds"]
        assert 0 < left < right < 512 and 0 < top < bottom < 512
        if item.get("foreground"):
            assert (output / item["foreground"]).exists()
        checked.append({"id": item["id"], "size": list(image.size), "alphaRange": list(extrema), "contentBounds": item["contentBounds"]})
    report = {
        "passed": True, "itemCount": len(records), "furnitureCount": 24,
        "foregroundCount": 4, "supportedRotations": [0],
        "totalPngBytes": sum(path.stat().st_size for path in output.glob("*.png")),
        "checks": checked,
        "limits": ["Only the single supplied front-left view is supported.", "Application integration and runtime room occlusion must be verified by the owning application agent."],
    }
    (source_dir / "validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Packed {len(records)} RGBA assets and 4 bed foreground layers; validation passed.")


if __name__ == "__main__":
    main()
