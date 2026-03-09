const ANL = parseInt(process.env.ADMIN_MIN_LEVEL, 10) || 91;
// 等級升級需求
export function expForNextLevel(level) {
  const MAX_LEVEL = AML-1;
  level = Math.min(level, MAX_LEVEL);

  return Math.floor(120 * level * level + 200);
}
