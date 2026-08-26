const SKILL_NAME_ZH: Record<string, string> = {
  Social: "社交",
  "Knowledge & Craft": "知识与技艺",
  "Science & Nature": "科学与自然",
  Investigation: "调查",
  Athletics: "运动",
  Swimming: "游泳",
  "Stealth & Security": "潜行与安保",
  "Repair & Engineering": "维修与工程",
  "Land Vehicle Operation": "陆地载具操作",
  "Watercraft Operation": "船舶操作",
  "Aircraft Operation": "飞行器操作",
  "Survival & Navigation": "生存与导航",
  "Medicine & Psychology": "医疗与心理",
  "Melee Combat": "近战",
  "Ranged Combat": "远程战斗",
  Languages: "语言",
  Occult: "神秘学",
};

export const getSkillNameZh = (name: string): string =>
  SKILL_NAME_ZH[name] ?? name;
