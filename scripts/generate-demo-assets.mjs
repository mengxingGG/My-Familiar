import { mkdir, writeFile } from "node:fs/promises";
// 原创占位角色：声明式帧资源，后续可替换为正式美术，无第三方素材。
for (const [id, name, color, leaf] of [
  ["mori", "小森", "#d9e8b7", "#779762"],
  ["luna", "月团", "#dedaf3", "#9b8abe"],
]) {
  const dir = `characters/${id}`;
  await mkdir(dir, { recursive: true });
  const frames = {};
  for (const action of ["idle", "greet", "happy", "think", "sleep", "drag"]) {
    frames[action] = [];
    for (let frame = 0; frame < 2; frame++) {
      const path = `${action}-${frame}.svg`;
      frames[action].push(path);
      const y = frame ? 2 : 0,
        closed = action === "sleep" || (action === "idle" && frame === 1);
      const eyes = closed
        ? '<path d="M74 111q8 7 16 0m35 0q8 7 16 0" fill="none" stroke="#4c5941" stroke-width="4" stroke-linecap="round"/>'
        : '<ellipse cx="83" cy="113" rx="5" ry="7" fill="#46533d"/><ellipse cx="135" cy="113" rx="5" ry="7" fill="#46533d"/><circle cx="84" cy="110" r="1.6" fill="white"/><circle cx="136" cy="110" r="1.6" fill="white"/>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="205" viewBox="0 0 220 205"><ellipse cx="110" cy="184" rx="62" ry="9" fill="#384d2b" opacity=".12"/><g transform="translate(0 ${y})"><path d="M78 73Q58 24 75 17Q92 20 97 72M126 69Q131 17 149 20Q160 33 142 81" fill="${color}" stroke="#778468" stroke-width="2.5"/><ellipse cx="110" cy="125" rx="70" ry="59" fill="${color}" stroke="#778468" stroke-width="2.5"/><ellipse cx="110" cy="148" rx="38" ry="28" fill="#fffbed" opacity=".65"/><ellipse cx="62" cy="128" rx="12" ry="7" fill="#e5aaa0" opacity=".6"/><ellipse cx="156" cy="128" rx="12" ry="7" fill="#e5aaa0" opacity=".6"/>${eyes}<path d="M102 129q8 ${action === "happy" ? 15 : 8} 16 0" fill="none" stroke="#566147" stroke-width="3" stroke-linecap="round"/><ellipse cx="76" cy="177" rx="19" ry="10" fill="${color}" stroke="#778468" stroke-width="2"/><ellipse cx="143" cy="177" rx="19" ry="10" fill="${color}" stroke="#778468" stroke-width="2"/><path d="M110 74Q90 48 102 40Q128 40 110 74M110 73Q118 44 136 48Q144 66 110 73" fill="${leaf}"/>${action === "think" ? '<text x="162" y="65" fill="#778468" font-size="27">…</text>' : ""}${action === "sleep" ? '<text x="160" y="65" fill="#778468" font-size="20">z Z</text>' : ""}${action === "happy" || action === "greet" ? '<path d="M176 90l4-10m4 17l9-5M35 90l-4-10" stroke="#d1ac62" stroke-width="3" stroke-linecap="round"/>' : ""}</g></svg>`;
      await writeFile(`${dir}/${path}`, svg);
    }
  }
  await writeFile(
    `${dir}/character.json`,
    JSON.stringify(
      {
        manifestVersion: 1,
        id,
        name,
        description:
          id === "mori"
            ? "一只安静陪着你的森林小伙伴。"
            : "用于验证角色替换的月色小伙伴。",
        license: "Project-original placeholder artwork",
        actions: Object.keys(frames),
        representations: { sprite: { fps: 1, frames } },
      },
      null,
      2,
    ),
  );
}
