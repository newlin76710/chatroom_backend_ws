// 共用函數

// 等級升級需求費氏數列
export function expForNextLevel(level) {
  let a = 100, b = 100;
  if (level <= 1) return 100;
  for (let i = 2; i <= level; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}

