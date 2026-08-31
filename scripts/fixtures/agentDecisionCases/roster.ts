// scripts/fixtures/agentDecisionCases/roster.ts

// =========================================================================
// Actor roster — 14 deliberately dissimilar NPCs
//
// Spread across profession (cop / PI / doctor / hunter / lawyer / dealer /
// enforcer / florist / bookseller / watchmaker / mayor / hustler / clerk),
// age 24-65, gender, sanity 37-75, and moral posture (upright / compromised /
// predatory / innocent).
// =========================================================================

// 注意：模组的技能名和动作定义的 skillCheck.skill 有系统性错位——定义写
// `Brawling` / `Pistol`，而 casssandra 的 NPC JSON 写 `Brawl` / `Handgun`。
// skillCheckTool 的名字查找匹配不上，会回退到 CoC 基础值（Brawling 25 /
// Pistol 20）。所以 brawling 和 pistol 两个场景里，Kovind 的 Brawl 65、Bruno 的
// Handgun 60 一次都用不上，掷骰结果偏低是引擎侧的问题，不是 agent 的。
export const ACTOR_ROSTER: Array<{ id: string; note: string }> = [
  {
    id: "Bruno Galilei",
    note: "33 男 · 警探 · SAN60 · 正直执着，受过战斗与勘查训练",
  },
  {
    id: "Shandra Hernandez",
    note: "31 女 · 私家侦探 · SAN60 · 温和、观察力强、职业性克制",
  },
  { id: "Lux Lynch", note: "27 男 · 警察 · SAN45 · 被腐蚀、恐惧、时刻怕暴露" },
  {
    id: "Kovind",
    note: "39 男 · 帮派打手 · SAN50 · 好斗；Brawl 65 / Handgun 65 / Stealth 60，据点在地下赌场",
  },
  {
    id: "Nancy Charlotte",
    note: "24 女 · 花店店主 · SAN50 · 纯善、脆弱、毫无战斗经验",
  },
  {
    id: "Vincent Galenus",
    note: "41 男 · 医院院长 · SAN37 · 医术精湛但被愧疚压垮",
  },
  {
    id: "Solomon",
    note: "50 男 · 占星师（占卜馆店主）· SAN65 · 内敛博学，Occult 75 / Library Use 70",
  },
  {
    id: "Marks White",
    note: "45 男 · 钟表匠 · SAN50 · 谨慎、算计；技能偏账目与话术（Accounting 60 / Psychology 55 / Fast Talk 50），并无机械或巧手专长",
  },
  {
    id: "Patrizio von Samsa",
    note: "50 男 · 市长/教派核心 · SAN75 · 操纵型，擅长话术",
  },
  {
    id: "Philip Scaletta",
    note: "28 男 · 街头混混 · SAN40 · 滑头、善撒谎、随时准备开溜",
  },
  {
    id: "Haran Greenwood",
    note: "65 男 · 火车站站务 · SAN50 · 沉默、循规蹈矩、能不动就不动",
  },
  {
    id: "Mrs. Barklyite (Lucia Shiny)",
    note: "33 女 · 律师 · SAN60 · 严谨、讲程序、擅长举证",
  },
  {
    id: "Johnny",
    note: "35 男 · 猎人 · SAN45 · 暴躁善妒；Brawl 65 / Shotgun 65 / Track 50 / Charm 90，无手枪与攀爬技能",
  },
  { id: "Angela", note: "34 女 · 毒贩 · SAN50 · 冷静务实、情感疏离、利益优先" },
];
