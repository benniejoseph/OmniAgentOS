export const MAX_ASSIGNED_SKILLS = 8;

export function assignedSkillsWithinRuntimeLimit<T>(
  skills: readonly T[],
): T[] {
  return skills.slice(0, MAX_ASSIGNED_SKILLS);
}
