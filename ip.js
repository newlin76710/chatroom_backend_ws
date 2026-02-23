export const ipMap = new Map();

export function addUserIP(ip, username) {
  const set = ipMap.get(ip) || new Set();
  if (!set.has(username) && set.size >= 5) {
    return false; // 阻擋
  }
  set.add(username);
  ipMap.set(ip, set);
  return true;
}

export function removeUserIP(ip, username) {
  const set = ipMap.get(ip);
  if (set) {
    set.delete(username);
    if (set.size === 0) ipMap.delete(ip); // 清空就刪掉整個 key
  }
}