"""裁切 imagegen 动作表并打包新角色；仅做网格裁切、等比缩放和锚点对齐。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / '.artifacts' / 'v2-art-ai'
CANVAS = (220, 205)
BASELINE = 192
ACTIONS = ['idle', 'greet', 'happy', 'think', 'sleep', 'drag', 'walk', 'eat', 'full', 'play', 'drowsy', 'hungry', 'weak', 'dejected', 'recover']
ROWS = {
    'a': [('idle', 0), ('greet', 0), ('happy', 0), ('think', 0), ('sleep', 0)],
    'b': [('drag', 0), ('walk', 0), ('eat', 0), ('eat', 4), ('full', 0), ('play', 0)],
    'c': [('play', 4), ('drowsy', 0), ('hungry', 0), ('weak', 0), ('dejected', 0), ('recover', 0)],
}
TIMINGS = {
    'idle': [1500, 180, 130, 1600], 'greet': [180, 140, 140, 500],
    'happy': [200, 180, 180, 500], 'think': [700, 600, 600, 800],
    'sleep': [1000, 1000, 1000, 1000], 'drag': [180, 160, 160, 180],
    'walk': [150, 150, 150, 150],
    'eat': [400, 200, 240, 400, 300, 240, 400, 600],
    'full': [300, 300, 400, 700], 'play': [240, 240, 200, 220, 240, 320, 400, 500],
    'drowsy': [500, 500, 750, 650], 'hungry': [750, 650, 700, 900],
    'weak': [1000, 900, 1000, 1100], 'dejected': [1300, 1300, 1300, 1300],
    'recover': [400, 350, 650, 600],
}
CHARACTERS = {
    'deepseek': ('鲸鱼娘', '蓝发与鲸尾的小伙伴，饭碗只在吃饭时出现。', ['上善无形', 'ZipZipPipe']),
    'gpt': ('GPT 小龙娘', '银白发、龙角与小翅膀的温柔伙伴。', ['ZipZipPipe']),
    'claude': ('Claude 小书灵', '橙发、日芒花饰与书本相伴的安静伙伴。', ['ZipZipPipe']),
}


def counts(im: Image.Image, axis: int) -> list[int]:
    """用不透明主体寻找行列间隙，保留源图内的真实姿势。"""
    a = im.getchannel('A').point(lambda p: 255 if p > 96 else 0)
    w, h = im.size
    if axis == 0:
        return [a.crop((x, 0, x + 1, h)).histogram()[255] for x in range(w)]
    return [a.crop((0, y, w, y + 1)).histogram()[255] for y in range(h)]


def cuts(values: list[int], number: int) -> list[int]:
    """生成图的网格间距略有偏差，在预期分界附近寻找透明谷底。"""
    size = len(values)
    out = [0]
    for k in range(1, number):
        center = round(k * size / number)
        radius = round(size / number * .30)
        lo = max(out[-1] + 20, center - radius)
        hi = min(size - 1, center + radius)
        boundary = min(range(lo, hi), key=lambda x: (sum(values[max(0, x - 2):x + 3]), abs(x - center)))
        out.append(boundary)
    return out + [size]


def crop_subject(cell: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int]]:
    bounds = cell.getchannel('A').point(lambda a: 255 if a > 64 else 0).getbbox()
    if bounds is None:
        raise ValueError('动作帧为空')
    x0, y0, x1, y1 = bounds
    bounds = (max(0, x0 - 2), max(0, y0 - 2), min(cell.width, x1 + 2), min(cell.height, y1 + 2))
    return cell.crop(bounds), bounds


def build(source: Path) -> dict:
    report = {'canvas': list(CANVAS), 'baseline': BASELINE, 'generation': 'built-in imagegen', 'characters': {}}
    previews = []
    for identity, (name, description, authors) in CHARACTERS.items():
        destination = ROOT / 'characters' / identity
        destination.mkdir(parents=True, exist_ok=True)
        frames: dict[str, list[str]] = {action: [] for action in ACTIONS}
        extracted = {}
        grids = {}
        for sheet, rows in ROWS.items():
            path = source / f'{identity}-{sheet}.png'
            im = Image.open(path).convert('RGBA')
            yc = cuts(counts(im, 1), len(rows))
            per_sheet = []
            for row, (action, offset) in enumerate(rows):
                strip = im.crop((0, yc[row], im.width, yc[row + 1]))
                xc = cuts(counts(strip, 0), 4)
                for column in range(4):
                    cell = strip.crop((xc[column], 0, xc[column + 1], strip.height))
                    subject, bounds = crop_subject(cell)
                    extracted[(action, offset + column)] = (subject, sheet)
                    per_sheet.append({'action': action, 'frame': offset + column, 'cell': [xc[column], yc[row], xc[column + 1], yc[row + 1]], 'subject': list(bounds)})
            grids[sheet] = {'size': list(im.size), 'rowCuts': yc, 'frames': per_sheet, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

        # 用每张表的直立动作校准比例，坐卧姿势不被放大成站姿高度。
        stand = {'a': [('idle', i) for i in range(4)], 'b': [('walk', i) for i in range(4)], 'c': [('hungry', i) for i in range(4)]}
        scales = {sheet: 172 / median(extracted[key][0].height for key in keys) for sheet, keys in stand.items()}
        for action in ACTIONS:
            count = len(TIMINGS[action])
            for index in range(count):
                subject, sheet = extracted[(action, index)]
                scale = scales[sheet]
                scale = min(scale, 204 / subject.width, 185 / subject.height)
                size = (max(1, round(subject.width * scale)), max(1, round(subject.height * scale)))
                subject = subject.resize(size, Image.Resampling.LANCZOS)
                canvas = Image.new('RGBA', CANVAS, (0, 0, 0, 0))
                x = (CANVAS[0] - size[0]) // 2
                y = BASELINE - size[1]
                canvas.alpha_composite(subject, (x, y))
                filename = f'{action}-{index}.webp'
                canvas.save(destination / filename, 'WEBP', lossless=True, method=6)
                frames[action].append(filename)
                if index == 0:
                    previews.append((identity, action, canvas.copy()))

        metadata = {
            'manifestVersion': 1, 'id': identity, 'name': name, 'description': description,
            'recommendedPersona': 'gentle',
            'license': 'Community-inspired AI-generated adaptation; see NOTICE.md',
            'actions': ACTIONS,
            'representations': {'sprite': {'fps': 6, 'frames': frames, 'timings': TIMINGS, 'canvas': list(CANVAS), 'anchor': [110, BASELINE]}},
            'attribution': {'authors': authors, 'reference': 'https://selinlee.github.io/ai-moe-atlas/zh/', 'generation': 'Built-in imagegen; newly generated animation frames, not original author artwork'},
        }
        (destination / 'character.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        notice = f'''# {name} 素材说明

本角色为社区设计方向的 AI 生成改绘动画，不是厂商官方角色，也不是原作者原图。

- 参考作者链：{' → '.join(authors)}。
- 造型参考索引：https://selinlee.github.io/ai-moe-atlas/zh/。
- 生成方式：内置 imagegen，2026-11-02；三张动作表，裁切、等比缩放并统一脚底锚点。
- 原始生成图、提示词和校验记录保存在开发工作区 `.artifacts/v2-art-ai/`；运行资源为本目录 WebP 帧。
- 不随源码许可证推定该社区设计获得商业授权。采用具体社区角色的原有署名和使用条件继续适用，发布时保留本说明并核验对应作品条件。

动作包包含 15 类动作、68 帧。透明画布为 220×205，脚底基线 y=192；每动作帧时长由 `representations.sprite.timings` 给出。`
fps` 仅为旧宿主的回退速度。
'''.replace('`\nfps`', '`fps`')
        (destination / 'NOTICE.md').write_text(notice, encoding='utf-8')
        report['characters'][identity] = {'actions': len(frames), 'frames': sum(map(len, frames.values())), 'scales': scales, 'sheets': grids}

    # 预览只用于检查透明边缘和全部动作，不作为产品资源。
    contact = Image.new('RGB', (5 * 240, 9 * 240), '#eee8df')
    draw = ImageDraw.Draw(contact)
    for i, (identity, action, frame) in enumerate(previews):
        x, y = i % 5 * 240, i // 5 * 240
        for by in range(0, 210, 14):
            for bx in range(0, 220, 14):
                color = '#f9f5ed' if (bx // 14 + by // 14) % 2 == 0 else '#e1e8dd'
                draw.rectangle((x + 10 + bx, y + 5 + by, x + 23 + bx, y + 18 + by), fill=color)
        contact.paste(frame, (x + 10, y + 5), frame)
        draw.text((x + 10, y + 216), f'{identity}: {action}', fill='#273d38')
    contact.save(ART / 'contact-sheet.jpg', quality=92)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, default=ART / 'source')
    args = parser.parse_args()
    ART.mkdir(parents=True, exist_ok=True)
    report = build(args.source_dir.resolve())
    (ART / 'asset-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: {'actions': value['actions'], 'frames': value['frames']} for key, value in report['characters'].items()}))


if __name__ == '__main__':
    main()
