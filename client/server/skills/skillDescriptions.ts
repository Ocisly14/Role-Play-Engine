const normalizeKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const SKILLS: Array<{
  name: string;
  zh: string;
  description: string;
  descriptionZh: string;
}> = [
  {
    name: "Social",
    zh: "社交",
    description:
      "Influence, deceive, intimidate, negotiate with, or read people.",
    descriptionZh: "影响、欺骗、恐吓、协商或洞察他人。",
  },
  {
    name: "Knowledge & Craft",
    zh: "知识与技艺",
    description:
      "Humanities, law, finance, appraisal, art, and practical craft knowledge.",
    descriptionZh: "人文、法律、财务、鉴定、艺术与实用技艺。",
  },
  {
    name: "Science & Nature",
    zh: "科学与自然",
    description:
      "Natural history and scientific reasoning, including biology, chemistry, and physics.",
    descriptionZh: "自然史和科学推理，包括生物、化学与物理。",
  },
  {
    name: "Investigation",
    zh: "调查",
    description:
      "Notice, listen for, research, follow, and connect evidence or clues.",
    descriptionZh: "观察、聆听、检索、追踪并串联证据或线索。",
  },
  {
    name: "Athletics",
    zh: "运动",
    description:
      "Climb, jump, run, throw, ride, and perform other non-swimming physical feats.",
    descriptionZh: "攀爬、跳跃、奔跑、投掷、骑乘及其他非游泳体能动作。",
  },
  {
    name: "Swimming",
    zh: "游泳",
    description: "Swim, dive, stay afloat, and act effectively in water.",
    descriptionZh: "游泳、潜水、漂浮与水中行动。",
  },
  {
    name: "Stealth & Security",
    zh: "潜行与安保",
    description:
      "Hide, sneak, disguise, pick locks, palm objects, and forge documents.",
    descriptionZh: "隐匿、潜行、乔装、开锁、巧手和伪造。",
  },
  {
    name: "Repair & Engineering",
    zh: "维修与工程",
    description:
      "Diagnose, repair, improvise, and operate technical or mechanical equipment.",
    descriptionZh: "诊断、维修、改装和操作技术或机械设备。",
  },
  {
    name: "Land Vehicle Operation",
    zh: "陆地载具操作",
    description: "Drive cars, motorcycles, trucks, and heavy land machinery.",
    descriptionZh: "驾驶汽车、摩托车、卡车及重型陆地机械。",
  },
  {
    name: "Watercraft Operation",
    zh: "船舶操作",
    description: "Pilot, navigate, and handle boats and other watercraft.",
    descriptionZh: "驾驶、操控与导航船只及其他水上载具。",
  },
  {
    name: "Aircraft Operation",
    zh: "飞行器操作",
    description: "Pilot and safely operate aircraft.",
    descriptionZh: "驾驶并安全操作飞行器。",
  },
  {
    name: "Survival & Navigation",
    zh: "生存与导航",
    description:
      "Find a route, endure hostile terrain, and secure necessities outdoors.",
    descriptionZh: "辨明路线、在险恶地形中生存并获取户外必需品。",
  },
  {
    name: "Medicine & Psychology",
    zh: "医疗与心理",
    description:
      "Provide first aid, diagnose or treat illness, and understand or treat the mind.",
    descriptionZh: "提供急救、诊疗疾病、理解或治疗心理问题。",
  },
  {
    name: "Melee Combat",
    zh: "近战",
    description: "Fight unarmed or with hand-held melee weapons.",
    descriptionZh: "徒手或使用手持近战武器战斗。",
  },
  {
    name: "Ranged Combat",
    zh: "远程战斗",
    description: "Use firearms, bows, crossbows, and thrown combat weapons.",
    descriptionZh: "使用枪械、弓弩和投掷类战斗武器。",
  },
  {
    name: "Languages",
    zh: "语言",
    description:
      "Read, write, speak, translate, or interpret languages and specialized registers.",
    descriptionZh: "阅读、书写、使用、翻译或解读语言及其专业语体。",
  },
  {
    name: "Occult",
    zh: "神秘学",
    description:
      "Recognize folklore, supernatural practices, and forbidden or Mythos knowledge.",
    descriptionZh: "辨识民俗、超自然实践与禁忌或神话知识。",
  },
];

const byName = new Map(
  SKILLS.map((skill) => [normalizeKey(skill.name), skill])
);
const byZhName = new Map(
  SKILLS.map((skill) => [normalizeKey(skill.zh), skill])
);

export const getSkillDescription = (skillName: string): string =>
  byName.get(normalizeKey(skillName))?.description ?? skillName;

export const getSkillDescriptionZh = (skillName: string): string => {
  const key = normalizeKey(skillName);
  return (
    byName.get(key)?.descriptionZh ??
    byZhName.get(key)?.descriptionZh ??
    skillName
  );
};

export const getSkillNameZh = (skillName: string): string =>
  byName.get(normalizeKey(skillName))?.zh ?? skillName;
