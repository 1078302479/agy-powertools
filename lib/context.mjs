// Compare usage and capacity from the same generation. Local tokenizer estimates
// can differ substantially from provider tokenization, particularly for tools.
export function contextSnapshot(generation, fallbackTokens = 0) {
  const metadata = generation?.context;
  const reportedMaxTokens = metadata?.maxTokens > 0 ? metadata.maxTokens : null;
  const actual = generation?.providerInputTokens;
  const hasActual = Number.isFinite(actual) && actual > 0;
  const estimatedUsedTokens = metadata?.usedTokens ?? null;
  const usedTokens = hasActual ? actual : Math.max(0, estimatedUsedTokens ?? fallbackTokens);
  // An inconsistent capacity cannot support an honest utilization percentage.
  const maxTokens = reportedMaxTokens != null && usedTokens <= reportedMaxTokens ? reportedMaxTokens : null;
  const percent = tokens => maxTokens ? Number((tokens / maxTokens * 100).toFixed(1)) : null;
  const groups = (metadata?.categories || []).flatMap(group => {
    const skills = group.label === 'System Prompt' && group.children?.find(child => child.label === 'skills');
    return skills ? [{ ...group, tokens: Math.max(0, group.tokens - skills.tokens) }, { key: 'skills', label: 'Skills', tokens: skills.tokens, tone: 'active' }] : [group];
  }).filter(group => Number.isFinite(group.tokens) && group.tokens > 0);
  const total = groups.reduce((sum, group) => sum + Math.max(0, group.tokens), 0);
  // The provider supplies only the total. Category counts remain estimates and
  // are labeled as such in the UI. Largest remainders preserve the exact total.
  const apportioned = groups.map(group => total ? usedTokens * Math.max(0, group.tokens) / total : 0);
  const counts = apportioned.map(Math.floor);
  const order = apportioned.map((value, index) => ({ index, remainder: value - counts[index] })).sort((a, b) => b.remainder - a.remainder);
  if (total) for (let i = 0, remaining = usedTokens - counts.reduce((a, b) => a + b, 0); i < remaining; i++) counts[order[i % order.length].index]++;
  const categories = groups.map((group, index) => ({ ...group, reportedTokens: group.tokens, tokens: total ? counts[index] : group.tokens, estimated: true, percent: percent(total ? counts[index] : group.tokens) }));
  if (!categories.length && usedTokens > 0) categories.push({ key: 'input', label: '输入上下文', tokens: usedTokens, estimated: !hasActual, percent: percent(usedTokens), tone: 'active' });
  const freeTokens = maxTokens == null ? null : maxTokens - usedTokens;
  if (freeTokens != null) categories.push({ key: 'free', label: '剩余空间', tokens: freeTokens, percent: percent(freeTokens), tone: 'free' });
  return { usedTokens, maxTokens, reportedMaxTokens, estimatedUsedTokens, usedPercent: percent(usedTokens), freePercent: freeTokens == null ? null : percent(freeTokens), categories, source: hasActual ? 'provider-usage' : metadata ? 'client-estimate' : 'transcript' };
}
