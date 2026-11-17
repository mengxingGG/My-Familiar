import type { LifeProduct } from "../../packages/contracts/life.ts";

const food = (
  id: string,
  name: string,
  price: number,
  nutrition: number,
  level: number,
  auto = false,
): LifeProduct => ({
  id,
  name,
  price,
  nutrition,
  unlockLevel: level,
  defaultAutoFeed: auto,
  kind: "food",
  purchasable: true,
  description: `恢复 ${nutrition} 点饱食${auto ? "，可自动食用" : "，适合手动喂食"}`,
  asset: `assets/life/${id}.png`,
});
const furnishing = (
  id: string,
  name: string,
  price: number,
  level: number,
  role: NonNullable<LifeProduct["placement"]>["role"],
  width: number,
  height: number,
  setId?: string,
  setName?: string,
): LifeProduct => ({
  id,
  name,
  price,
  unlockLevel: level,
  kind: "furniture",
  purchasable: price > 0,
  setId,
  setName,
  description:
    role === "bed"
      ? "放进小窝后，伙伴可以在这里休息"
      : role === "table"
        ? "为小窝添一个温暖的角落"
        : "可自由摆放，收回后继续保存在背包中",
  asset: `assets/life/${id}.png`,
  placement: {
    width,
    height,
    layer: id.endsWith("-rug") || id === "starter-mat" ? "rug" : "floor",
    rotations: [0],
    role,
  },
});
const sets = [
  {
    id: "wood",
    name: "暖木小居",
    level: 1,
    items: [
      ["bed", "暖木矮床", 180, "bed", 220, 130],
      ["table", "小圆桌", 120, "table", 140, 100],
      ["stool", "圆木凳", 80, "seat", 90, 70],
      ["cabinet", "双门小柜", 160, "decoration", 150, 90],
      ["shelf", "矮书架", 140, "decoration", 160, 80],
      ["rug", "编织地毯", 100, "decoration", 270, 170],
    ],
  },
  {
    id: "forest",
    name: "苔光森林",
    level: 5,
    items: [
      ["bed", "蘑菇软床", 240, "bed", 220, 130],
      ["table", "树桩桌", 140, "table", 140, 100],
      ["chair", "叶片椅", 100, "seat", 100, 80],
      ["cabinet", "树洞柜", 200, "decoration", 150, 90],
      ["lamp", "萤光灯", 120, "decoration", 70, 60],
      ["rug", "苔藓地毯", 120, "decoration", 270, 170],
    ],
  },
  {
    id: "ocean",
    name: "月湾海居",
    level: 8,
    items: [
      ["bed", "贝壳床", 260, "bed", 230, 140],
      ["table", "潮汐桌", 160, "table", 150, 100],
      ["stool", "泡泡凳", 100, "seat", 90, 70],
      ["cabinet", "漂流小柜", 220, "decoration", 150, 90],
      ["lamp", "水母灯", 140, "decoration", 70, 60],
      ["rug", "浪纹地毯", 120, "decoration", 270, 170],
    ],
  },
  {
    id: "star",
    name: "星灯书房",
    level: 12,
    items: [
      ["bed", "星月小床", 280, "bed", 230, 140],
      ["desk", "阅读书桌", 180, "table", 170, 100],
      ["chair", "绒面软椅", 120, "seat", 100, 80],
      ["shelf", "星空书柜", 240, "decoration", 170, 90],
      ["lamp", "星灯", 160, "decoration", 70, 60],
      ["rug", "星轨地毯", 140, "decoration", 270, 170],
    ],
  },
] as const;

export const LIFE_CATALOG: LifeProduct[] = [
  food("food-basic", "基础口粮", 4, 40, 1, true),
  food("food-fruit", "果盘", 6, 45, 3),
  food("food-bento", "便当", 8, 65, 3),
  food("food-dessert", "精致甜点", 12, 80, 12),
  ...(
    [
      ["ball", "小球", 30, 1],
      ["pinwheel", "纸风车", 40, 1],
      ["blocks", "小积木", 80, 3],
    ] as const
  ).map(
    ([id, name, price, level]): LifeProduct => ({
      id: `toy-${id}`,
      name,
      price,
      unlockLevel: level,
      kind: "toy",
      purchasable: true,
      description: "可以反复玩耍，也可以摆进小窝",
      asset: `assets/life/toy-${id}.png`,
      placement: {
        width: 70,
        height: 60,
        layer: "floor",
        rotations: [0],
        role: "toy",
      },
    }),
  ),
  ...sets.flatMap((set) =>
    set.items.map(([id, name, price, role, width, height]) =>
      furnishing(
        `${set.id}-${id}`,
        name,
        price,
        set.level,
        role,
        width,
        height,
        set.id,
        set.name,
      ),
    ),
  ),
  furnishing("starter-bowl", "小食盆", 0, 1, "bowl", 80, 60),
  furnishing("starter-mat", "休息软垫", 0, 1, "bed", 220, 130),
  furnishing("memorial-trophy", "成长纪念摆件", 0, 20, "decoration", 70, 60),
];
export const lifeProduct = (id: string) =>
  LIFE_CATALOG.find((item) => item.id === id);
for (const item of LIFE_CATALOG) {
  if (!item.placement) continue;
  const role = item.placement.role;
  const size =
    item.placement.layer === "rug"
      ? 320
      : role === "bed"
        ? 280
        : role === "bowl"
          ? 140
          : role === "toy"
            ? 128
            : role === "seat"
              ? 170
              : role === "table"
                ? 220
                : item.id.endsWith("-lamp")
                  ? 180
                  : item.id === "memorial-trophy"
                    ? 120
                    : 220;
  item.visual = {
    width: size,
    height: size,
    anchor: { x: 0.5, y: 0.9375 },
    interaction: { x: 0.5, y: role === "bed" ? 0.63 : 0.7 },
    ...(item.id.endsWith("-bed")
      ? { foreground: `assets/life/${item.id}-foreground.png` }
      : {}),
  };
}
export const MILESTONE_ITEMS: Record<number, string> = {
  3: "toy-ball",
  5: "forest-chair",
  8: "ocean-rug",
  12: "star-lamp",
  20: "memorial-trophy",
};
