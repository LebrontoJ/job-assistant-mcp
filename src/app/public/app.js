'use strict';
const $ = id => document.getElementById(id);
const labels = { wishlist: '待投递', applied: '已投递', oa: '笔试', interview: '面试', offer: 'Offer', rejected: '未通过', withdrawn: '已撤回' };
let config, report, pending, analysisController, analysedJD, deciding = false;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = `notice${error ? ' error' : ''}`; $('notice').hidden = false; }
async function api(path, payload, signal) {
  const res = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: { 'X-App-Token': config.token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: payload === undefined ? undefined : JSON.stringify(payload), signal });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error?.message ?? '请求失败'}${data.taskId ? ` · 任务 ${data.taskId}` : ''}`);
  return data;
}
function options(select, value) {
  select.replaceChildren(...config.statuses.map(status => { const option = el('option', labels[status] ?? status); option.value = status; option.selected = status === value; return option; }));
}
function section(title) { const node = el('section', undefined, 'report-section'); node.append(el('h3', title)); return node; }
function showReport(data) {
  report = data;
  $('empty').hidden = true; $('report').hidden = false; $('report').replaceChildren();
  $('report-status').textContent = `${data.requirements.length} 条岗位要求`;
  $('step2').classList.add('active');
  const requirementSection = section('01 / 岗位要求与检索依据');
  requirementSection.append(el('p', '以下为检索信号。相关片段不等于满足要求，请核查原文；年限尚未自动计算。', 'muted'));
  for (const item of data.requirements) {
    const row = el('div', undefined, 'requirement');
    row.append(el('span', { supported: '有词面依据', weak: '需进一步核实', no_evidence: '未找到依据' }[item.support], `support ${item.support}`), el('p', item.item));
    for (const evidence of item.evidence) {
      const source = data.evidence.find(e => e.id === evidence.chunkId);
      const details = el('details'); details.append(el('summary', `查看依据 · ${evidence.chunkId}`), el('div', source?.text ?? evidence.excerpt, 'source')); row.append(details);
    }
    requirementSection.append(row);
  }
  if (!data.requirements.length) requirementSection.append(el('p', '未识别到独立要求。请补充职责或要求部分。', 'muted'));
  $('report').append(requirementSection);
  const drafts = section('02 / 可采用的经历表达');
  drafts.append(el('p', config.mode === 'live' ? '仅展示通过证据校验的改写。语义校验仍可能出错，请人工核对。' : '离线模式展示原文摘录，不进行模型改写。', 'muted'));
  for (const item of data.draft.rewrites) {
    const bullet = el('div', undefined, 'bullet'); bullet.append(el('div', item.text));
    for (const id of item.evidenceIds) { const link = el('a', `[${id}]`, 'citation'); link.href = `#source-${data.evidence.findIndex(e => e.id === id)}`; bullet.append(link); }
    drafts.append(bullet);
  }
  if (!data.draft.rewrites.length) drafts.append(el('p', '没有可验证的草稿。请补充资料后重试；未通过校验的内容已移除。', 'muted'));
  const removed = data.validation.filter(v => !v.supported).length;
  if (removed) drafts.append(el('p', `校验与修复过程中拦截 ${removed} 条陈述（可能含重复尝试）。`, 'muted'));
  $('report').append(drafts);
  const gaps = section('03 / 缺失信息与下一步');
  const list = el('ul');
  for (const text of data.draft.suggestions) list.append(el('li', text));
  if (!data.draft.suggestions.length) list.append(el('li', '补充岗位相关的真实成果、时间范围和可核实指标，以便进一步判断。'));
  gaps.append(list, el('p', '学习建议代表未来行动，不应写成已有经验。资料未覆盖，不代表你没有这项能力。', 'muted'));
  $('report').append(gaps);
  const sources = section('原始证据');
  data.evidence.forEach((source, index) => {
    const details = el('details'); details.id = `source-${index}`;
    details.append(el('summary', `${source.id} · ${source.heading}`), el('div', source.text, 'source')); sources.append(details);
  });
  sources.append(el('p', `任务 ID：${data.taskId}`, 'muted')); $('report').append(sources);
  $('company').value = data.jd.company ?? ''; $('role').value = data.jd.title ?? '';
  $('tracking').hidden = false;
}
async function refreshBoard() {
  const data = await api('/api/board');
  $('board').replaceChildren(); $('board-count').textContent = `${data.applications.length}`;
  for (const status of config.statuses) {
    const column = el('section', undefined, 'column'); const heading = el('div', undefined, 'column-heading');
    const rows = data.applications.filter(a => a.status === status);
    heading.append(el('span', labels[status]), el('span', `${rows.length}`, 'column-count')); column.append(heading);
    for (const row of rows) {
      const card = el('article', undefined, 'card'); card.append(el('h3', row.company), el('p', row.role));
      if (row.nextFollowUp) card.append(el('p', `跟进 ${row.nextFollowUp}`));
      const label = el('label', '调整阶段'); const select = el('select'); select.setAttribute('aria-label', `${row.company} 投递阶段`); options(select, row.status); label.append(select);
      const button = el('button', '预览阶段变更', 'secondary'); button.disabled = true;
      select.addEventListener('change', () => { button.disabled = select.value === row.status; });
      button.addEventListener('click', async () => { button.disabled = true; try { await preview({ id: row.id, status: select.value }); } catch (error) { notice(error.message, true); } finally { button.disabled = select.value === row.status; } });
      card.append(label, button);
      if (row.notes) { const details = el('details'); details.append(el('summary', '查看记录与依据'), el('div', row.notes, 'source')); card.append(details); }
      column.append(card);
    }
    if (!rows.length) column.append(el('p', '暂无记录', 'empty-column'));
    $('board').append(column);
  }
}
async function preview(payload) {
  const data = await api('/api/preview', payload);
  if (data.status === 'duplicate') { notice('看板中已有相同公司与职位。可在下方卡片预览阶段变更。'); await refreshBoard(); return; }
  pending = data;
  $('preview-content').replaceChildren(); $('decision-error').hidden = true;
  const isUpdate = !!data.current;
  $('preview-title').textContent = isUpdate ? '确认投递阶段变更' : '确认添加这个机会';
  if (isUpdate) {
    const row = el('div', undefined, 'preview-row'); row.append(el('b', '投递记录'), el('span', `${data.current.company} · ${data.current.role}`)); $('preview-content').append(row);
  }
  const fields = isUpdate ? data.changes : data.preview;
  const fieldNames = { company: '公司', role: '职位', status: '阶段', notes: '保存的经历与证据', nextFollowUp: '下次跟进', url: '岗位链接' };
  for (const [key, value] of Object.entries(fields)) {
    const row = el('div', undefined, 'preview-row'); row.append(el('b', fieldNames[key] ?? key));
    if (isUpdate) row.append(el('div', `当前：${key === 'status' ? labels[data.current[key]] : data.current[key] ?? '空'}`, 'old'));
    row.append(el('div', `${isUpdate ? '变更为：' : ''}${key === 'status' ? labels[value] : String(value || '空')}`, 'new')); $('preview-content').append(row);
  }
  $('preview-expiry').textContent = `预览有效至 ${new Date(data.operation.expiresAt).toLocaleTimeString()}。当前尚未写入。`;
  $('approve').disabled = false; $('cancel').disabled = false;
  $('preview-dialog').showModal();
}
async function decide(decision) {
  if (!pending || deciding) return;
  deciding = true; $('approve').disabled = true; $('cancel').disabled = true; $('decision-error').hidden = true;
  try {
    const result = await api('/api/decision', { operationId: pending.operation.id, decision });
    $('preview-dialog').close(); pending = undefined;
    if (result.status === 'cancelled') notice('已取消此次操作，没有写入看板。');
    else { $('step3').classList.add('active'); notice(`已保存，看板已更新。任务 ${result.taskId}`); }
    await refreshBoard();
  } catch (error) { $('decision-error').textContent = `${error.message}。可重试同一操作；写入结果会去重。若预览已过期或内容已变，请取消并重新预览。`; $('decision-error').hidden = false; }
  finally { deciding = false; $('approve').disabled = false; $('cancel').disabled = false; }
}
$('jd').addEventListener('input', () => {
  $('char-count').textContent = `${$('jd').value.length} 字符`;
  if (report && $('jd').value !== analysedJD) {
    report = undefined; $('tracking').hidden = true; $('report-status').textContent = '岗位描述已修改';
    notice('岗位描述已修改。当前报告对应上一份 JD，请重新分析后添加机会。');
  }
});
$('sample').addEventListener('click', async () => { try { const data = await api('/api/sample'); $('jd').value = data.jd; $('jd').dispatchEvent(new Event('input')); } catch (error) { notice(error.message, true); } });
$('analyse-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (analysisController) return;
  analysisController = new AbortController(); report = undefined;
  const submittedJD = $('jd').value;
  $('tracking').hidden = true; $('report').hidden = true; $('empty').hidden = false;
  $('report-panel').setAttribute('aria-busy', 'true'); $('report-status').textContent = '正在检索与校验…';
  $('analyse').disabled = true; $('sample').disabled = true; $('stop').hidden = false; $('analyse').textContent = '分析中…';
  notice(config.mode === 'live' ? '正在检索履历、生成并校验改写，请稍候。' : '正在通过 MCP 检索资料并整理原文摘录。');
  try {
    const data = await api('/api/analyse', { jd: submittedJD }, analysisController.signal);
    analysedJD = submittedJD; showReport(data);
    if ($('jd').value !== submittedJD) $('jd').dispatchEvent(new Event('input'));
    else notice('分析完成。先核查原文，再选择是否加入看板。');
  } catch (error) { $('report-status').textContent = '未完成'; notice(error.name === 'AbortError' ? '已停止分析，没有写入看板。' : error.message, error.name !== 'AbortError'); }
  finally { analysisController = undefined; $('report-panel').setAttribute('aria-busy', 'false'); $('analyse').disabled = false; $('sample').disabled = false; $('stop').hidden = true; $('analyse').textContent = '重新分析 →'; }
});
$('stop').addEventListener('click', () => analysisController?.abort());
$('track-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!report) return;
  const button = event.submitter; button.disabled = true;
  try { await preview({ taskId: report.taskId, company: $('company').value, role: $('role').value, status: $('new-status').value, ...($('followup').value ? { nextFollowUp: $('followup').value } : {}) }); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});
$('approve').addEventListener('click', () => decide('approve'));
$('cancel').addEventListener('click', () => decide('cancel'));
$('preview-dialog').addEventListener('cancel', event => { event.preventDefault(); if (!deciding) void decide('cancel'); });
$('refresh').addEventListener('click', () => refreshBoard().catch(error => notice(error.message, true)));
(async () => {
  try {
    const res = await fetch('/api/config'); if (!res.ok) throw new Error('无法连接本地服务'); config = await res.json();
    $('mode').textContent = config.mode === 'live' ? `实时模型 · ${config.model}` : '离线模式 · 资料摘录';
    options($('new-status'), 'wishlist'); await refreshBoard();
  } catch (error) { notice(error.message, true); $('analyse').disabled = true; }
})();
