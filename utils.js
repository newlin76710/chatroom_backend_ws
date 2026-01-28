// 等級升級需求費氏數列（最高到 90 級）
export function expForNextLevel(level) {
  const MAX_LEVEL = 90;
  level = Math.min(level, MAX_LEVEL); // 限制最大到 90

  let a = 100, b = 100;
  if (level <= 1) return 100;

  for (let i = 2; i <= level; i++) {
    const next = a + b;
    a = b;
    b = next;
  }

  return b;
}
