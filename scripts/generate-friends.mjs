import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// 原创矢量角色；语义动作与外形解耦，未来的 3D 表现可以复用同一份角色元信息。
const friends = [
  ["mianmian", "绵绵", "一只软乎乎的云朵羊，愿意慢慢听你说。", "gentle"],
  ["lili", "栗栗", "戴圆眼镜的小猫头鹰，总会替你多想一步。", "thorough"],
  ["fangfang", "方方", "一台有小小心灯的方脑袋机器人。", "direct"],
  ["youzi", "柚子", "蓬松尾巴的小狐狸，带着橙子味的好心情。", "enthusiastic"],
  ["diandian", "点点", "围着薄荷围巾的小企鹅，做事干脆又认真。", "concise"],
];
const actions = ["idle", "greet", "happy", "think", "sleep", "drag"];
function draw(id, action, frame) {
  const closed = action === "sleep" || (action === "idle" && frame === 1);
  const joy = action === "happy" || action === "greet";
  const eyes = closed
    ? '<path d="M82 107q7 5 14 0m28 0q7 5 14 0"/>'
    : joy
      ? '<path d="M82 111q7-12 14 0m28 0q7-12 14 0"/>'
      : '<ellipse cx="89" cy="108" rx="4" ry="6" fill="currentColor"/><ellipse cx="131" cy="108" rx="4" ry="6" fill="currentColor"/>';
  const face = `<g color="#384149" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none">${eyes}<path d="M104 123q6 6 12 0"/></g><g fill="#e99e97" opacity=".5"><ellipse cx="73" cy="120" rx="8" ry="4"/><ellipse cx="147" cy="120" rx="8" ry="4"/></g>`;
  const feet =
    '<ellipse cx="83" cy="179" rx="16" ry="7" fill="#526976"/><ellipse cx="137" cy="179" rx="16" ry="7" fill="#526976"/>';
  const bodies = {
    mianmian: `<g fill="#ece0c7" stroke="#cebfa3" stroke-width="2"><ellipse cx="51" cy="108" rx="15" ry="22" transform="rotate(-28 51 108)"/><ellipse cx="169" cy="108" rx="15" ry="22" transform="rotate(28 169 108)"/></g><path d="M67 157v20m85-20v20" stroke="#9d8d79" stroke-width="12" stroke-linecap="round"/><g fill="#fffaf0" stroke="#e1d5bd" stroke-width="2"><path d="M54 124Q26 97 53 81Q42 52 76 52Q87 27 110 45Q136 28 148 54Q182 51 171 82Q197 105 169 127Q178 159 147 164Q130 184 111 167Q86 184 72 164Q41 164 54 124Z"/></g><ellipse cx="110" cy="116" rx="52" ry="43" fill="#eddfc6"/>${face}<path d="M103 42q-6-12 7-14q14 1 4 14" fill="none" stroke="#d6c8ac" stroke-width="4"/>`,
    lili: `${feet}<path d="M56 62L54 34L84 51Q110 42 136 51L164 34L164 65Q185 106 166 159Q144 184 110 176Q71 183 53 154Q35 108 56 62Z" fill="#aa7858" stroke="#855e4c" stroke-width="3"/><path d="M62 86Q76 63 110 83Q147 63 161 88Q164 135 110 163Q56 136 62 86" fill="#f6e4c9"/><path d="M52 108q-14 25 10 42m106-42q14 25-10 42" fill="#855e4c"/><g fill="none" stroke="#566b63" stroke-width="3"><circle cx="87" cy="107" r="22"/><circle cx="133" cy="107" r="22"/><path d="M109 102h2"/></g>${face}<path d="M103 120l7 10 7-10Z" fill="#d8a44e"/><path d="M94 148l6 5m9-5 6 5m9-5 6 5" stroke="#c79870" stroke-width="3" stroke-linecap="round"/>`,
    fangfang: `<path d="M110 43V29" stroke="#738ea3" stroke-width="6"/><circle cx="110" cy="23" r="8" fill="${frame ? "#f9cb77" : "#86c9b2"}"/>${feet}<rect x="65" y="130" width="90" height="47" rx="17" fill="#95aebe" stroke="#607a8e" stroke-width="3"/><rect x="39" y="83" width="18" height="34" rx="7" fill="#7f9cac"/><rect x="163" y="83" width="18" height="34" rx="7" fill="#7f9cac"/><rect x="51" y="48" width="118" height="95" rx="23" fill="#c5dce5" stroke="#6e8b9a" stroke-width="3"/><rect x="66" y="74" width="88" height="57" rx="14" fill="#eff7eb"/>${face}<path d="M104 151q6-7 12 0q5 7-6 13q-11-6-6-13Z" fill="#efac99"/><path d="M69 142l-15 18m98-18 15 18" stroke="#6e8b9a" stroke-width="10" stroke-linecap="round"/>`,
    youzi: `<path d="M143 154Q202 174 195 100Q166 112 152 138" fill="#d68048" stroke="#b96b3c" stroke-width="3"/><path d="M183 137q17-15 12-37q-15 6-25 15Z" fill="#fff1d6"/><ellipse cx="104" cy="148" rx="47" ry="32" fill="#e89a58"/><path d="M57 88L49 31Q75 32 88 60Q110 53 131 60Q148 34 171 31L163 87Q179 124 148 141Q110 164 73 141Q42 124 57 88Z" fill="#eea365" stroke="#ce804d" stroke-width="3"/><path d="M58 44l7 34 16-13Z M159 44l-7 34-16-13Z" fill="#ae694b"/><path d="M56 105Q73 92 110 128Q145 92 165 105Q162 145 110 150Q60 145 56 105" fill="#fff1d6"/>${face}<path d="M105 119q5-4 10 0l-5 6Z" fill="#56433e"/><ellipse cx="83" cy="177" rx="16" ry="7" fill="#ce804d"/><ellipse cx="133" cy="177" rx="16" ry="7" fill="#ce804d"/>`,
    diandian: `<ellipse cx="82" cy="179" rx="18" ry="8" fill="#e1b46c"/><ellipse cx="137" cy="179" rx="18" ry="8" fill="#e1b46c"/><path d="M61 97Q43 115 42 145q13 8 23-13m94-35q18 18 19 48q-13 8-23-13" fill="#3d5966"/><path d="M57 93Q56 42 110 43Q164 42 163 93L169 139Q172 178 110 178Q48 178 51 139Z" fill="#577886" stroke="#3d5966" stroke-width="3"/><path d="M72 85q18-18 38 1q22-19 38-1l8 53q6 32-46 32q-52 0-46-32Z" fill="#f8f4e9"/>${face}<path d="M102 120q8-6 16 0l-8 7Z" fill="#e8b965"/><path d="M57 137q50 17 105 0v11q-55 17-105 0Z" fill="#90c7ae"/><path d="M134 147v25l15-5-3-22" fill="#7fbba0"/>`,
  };
  let symbol =
    action === "sleep"
      ? '<text x="172" y="45" font-family="sans-serif" font-size="19" fill="#789185">z Z</text>'
      : action === "think"
        ? '<g fill="#c1d5c6"><circle cx="172" cy="58" r="4"/><circle cx="182" cy="44" r="6"/><circle cx="194" cy="26" r="9"/></g>'
        : joy
          ? '<path d="M30 52v14m-7-7h14m155-8v10m-5-5h10" stroke="#d5ae61" stroke-width="3" stroke-linecap="round"/>'
          : "";
  const tilt =
    action === "drag"
      ? frame
        ? 5
        : -5
      : action === "greet"
        ? frame
          ? 2
          : -2
        : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="205" viewBox="0 0 220 205"><ellipse cx="110" cy="192" rx="64" ry="7" fill="#263e3c" opacity=".12"/><g transform="translate(0 ${frame ? -2 : 0}) rotate(${tilt} 110 130)">${bodies[id]}</g>${symbol}</svg>`;
}
for (const [id, name, description, recommendedPersona] of friends) {
  const directory = join("characters", id);
  await mkdir(directory, { recursive: true });
  const frames = {};
  for (const action of actions) {
    frames[action] = [];
    for (let frame = 0; frame < 2; frame++) {
      const filename = `${action}-${frame}.svg`;
      frames[action].push(filename);
      await writeFile(join(directory, filename), draw(id, action, frame));
    }
  }
  await writeFile(
    join(directory, "character.json"),
    JSON.stringify(
      {
        manifestVersion: 1,
        id,
        name,
        description,
        recommendedPersona,
        license: "Project-original artwork",
        actions,
        representations: { sprite: { fps: 1, frames } },
      },
      null,
      2,
    ) + "\n",
  );
}
for (const id of ["mori", "luna"]) {
  const file = join("characters", id, "character.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.recommendedPersona = "gentle";
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}
console.log("五个新角色包已生成；小森和月团推荐温柔陪伴。");
