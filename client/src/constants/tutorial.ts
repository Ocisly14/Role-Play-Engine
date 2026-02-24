export const TUTORIAL_SEEN_STORAGE_PREFIX = "coc.tutorial.seen.v1";

export function getTutorialSeenStorageKey(email?: string | null): string {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return `${TUTORIAL_SEEN_STORAGE_PREFIX}.anonymous`;
  }
  return `${TUTORIAL_SEEN_STORAGE_PREFIX}.${normalizedEmail}`;
}

export const TUTORIAL_DEMO_INPUT = "观察周围，看有没有可疑人物";
export const TUTORIAL_SCENE_TRANSITION_INPUT = "我要前往飞机码头";
