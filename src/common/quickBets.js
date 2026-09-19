// D6：快捷下注数值生成规则（服务端为唯一计算来源，D19）
export const PRESET_BASE_CHIPS = [100, 200, 400, 500, 800, 1000];

const PERCENTS = [5, 10, 20, 25, 50, 100];

// 档位 = 本金 × {5%,10%,20%,25%,50%,100%，向下取整}，去重保序（预设本金恒为 6 个正整数）
export const quickBets = (baseChips) => {
  const out = [];
  for (const percent of PERCENTS) {
    const value = Math.floor((baseChips * percent) / 100);
    if (value > 0 && !out.includes(value)) out.push(value);
  }
  return out;
};
