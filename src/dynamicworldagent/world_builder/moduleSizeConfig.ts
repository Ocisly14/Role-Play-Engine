export interface ModuleSizeConfig {
  size: "small" | "medium" | "large";
  macroLocationCount: [number, number];
  subSceneRange: [number, number];
  totalSceneCap: number;
}

export const MODULE_SIZE_CONFIGS: Record<string, ModuleSizeConfig> = {
  small: {
    size: "small",
    macroLocationCount: [4, 6],
    subSceneRange: [1, 3],
    totalSceneCap: 25,
  },
  medium: {
    size: "medium",
    macroLocationCount: [7, 12],
    subSceneRange: [2, 4],
    totalSceneCap: 50,
  },
  large: {
    size: "large",
    macroLocationCount: [13, 20],
    subSceneRange: [2, 5],
    totalSceneCap: 80,
  },
};

export function getModuleSizeConfig(size: string): ModuleSizeConfig {
  return MODULE_SIZE_CONFIGS[size] ?? MODULE_SIZE_CONFIGS.medium;
}
