import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync,mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import vm from'node:vm';
import{toZhTw}from'../lib/zh-tw.mjs';
import{renderAuxPaneHtml}from'../lib/sidecar-ui.mjs';
import{formatRelativeTime,formatResetCountdown}from'../lib/account-helpers.mjs';
import{createSettingsStore}from'../lib/settings.mjs';
test('native settings translations preserve product names and English input terminology',()=>{
 const document={nodeType:9,createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:()=>[]};
 const context=vm.createContext({document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){} disconnect(){}}});
 vm.runInContext(readFileSync('lib/native-i18n.js','utf8'),context);const t=context.__agyI18n.t;
 assert.equal(t('Interface Layout','zh-CN'),'界面布局');assert.equal(t('Queued Messages','zh-CN'),'后续消息');assert.equal(t('输入','en'),'Input');
 assert.equal(t('Google AI Ultra','zh-CN'),'Google AI Ultra');assert.equal(t('Google Sans','zh-CN'),'Google Sans');assert.equal(t('Ctrl','zh-CN'),'Ctrl');
 assert.equal(t('Your Plan: Google AI Ultra','zh-CN'),'当前套餐：Google AI Ultra');
 assert.equal(t('You have used some of your weekly limit, it will fully refresh in 3 days, 11 hours.','zh-CN'),'周额度将在 3 天 11 小时后重置。');
 assert.equal(t('Quote','zh-CN'),'引用');assert.equal(t('Ask /btw','zh-CN'),'顺便问 /btw');
 assert.equal(t('Local Permissions','zh-CN'),'本地权限');assert.equal(t('Every command requires approval.','zh-CN'),'每条命令均需批准。');
 assert.equal(t('Ask before sensitive operations.','zh-CN'),'执行敏感操作前询问。');assert.equal(t('Run all commands without restrictions.','zh-CN'),'无限制运行所有命令。');
 assert.equal(t('Background Tasks','zh-CN'),'后台任务');assert.equal(t('See all (6)','zh-CN'),'查看全部 (6)');
 assert.equal(t('See all','zh-CN'),'查看全部');assert.equal(t('Conversation Name','zh-CN'),'会话名称');assert.equal(t('Conversation ID','zh-CN'),'会话 ID');assert.equal(t('Project Name','zh-CN'),'项目名称');
 assert.equal(t('Split Right','zh-CN'),'向右拆分');assert.equal(t('Split Down','zh-CN'),'向下拆分');assert.equal(t('Replace with New','zh-CN'),'替换为新会话');
 assert.equal(t('Search or enter a URL','zh-CN'),'搜索或输入网址');assert.equal(t('Open File','zh-CN'),'打开文件');
 assert.equal(t('Side Question','zh-CN'),'支线提问');assert.equal(t('New Side Question','zh-CN'),'新建支线提问');
 assert.equal(t('Ask a side question without interrupting the main conversation','zh-CN'),'发起支线提问，不打断主对话');
 assert.equal(t('12 files changed','zh-CN'),'12 个文件已更改');assert.equal(t('1 file changed','zh-CN'),'1 个文件已更改');
 assert.equal(t('5h limit','zh-CN'),'5 小时限额');assert.equal(t('55% left','zh-CN'),'剩余 55%');assert.equal(t('100% left','zh-CN'),'剩余 100%');
 assert.equal(t('Resets in 5d 1h','zh-CN'),'5 天 1 小时后重置');assert.equal(t('Resets in 3h 33m','zh-CN'),'3 小时 33 分钟后重置');
 assert.equal(t('Pull Requests','zh-CN'),'Pull Requests');assert.equal(t('14m ago','zh-CN'),'14m ago');
 assert.equal(t('Turbo','zh-CN'),'Turbo');assert.equal(t('当前会话','en'),'Current conversation');
});

test('Traditional Chinese (zh-TW) uses Taiwan IT terminology, converts UI strings cleanly, and persists in settings',()=>{
  const document={nodeType:9,createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:()=>[]};
  const context=vm.createContext({document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){} disconnect(){}},__agyToZhTw:toZhTw});
  vm.runInContext(readFileSync('lib/native-i18n.js','utf8'),context);
  const t=context.__agyI18n.t;
  assert.equal(t('Settings','zh-TW'),'設定');
  assert.equal(t('Context window','zh-TW'),'上下文視窗');
  assert.equal(t('Cache hit','zh-TW'),'快取命中');
  assert.equal(t('Open File','zh-TW'),'開啟檔案');
  assert.equal(t('Restore defaults','zh-TW'),'恢復預設設定');
  assert.equal(t('Every command requires approval.','zh-TW'),'每條命令均需批准。');
  assert.equal(t('Background Tasks','zh-TW'),'背景任務');
  assert.equal(t('Your Plan: Google AI Ultra','zh-TW'),'目前方案：Google AI Ultra');
  assert.equal(t('Resets in 3h 33m','zh-TW'),'3 小時 33 分鐘後重置');
  assert.equal(toZhTw('复制文件并恢复默认设置，助手回复缓存异常'), '複製檔案並恢復預設設定，助手回覆快取異常');
  assert.equal(toZhTw('按实际规划 / 执行模型计价'), '按實際規劃 / 執行模型計價');
  assert.equal(formatRelativeTime(0, 30000, 'zh-TW'), '剛剛');
  assert.equal(formatRelativeTime(0, 120000, 'zh-TW'), '2 分鐘前');
  assert.equal(formatResetCountdown(7200000, 0, 'zh-TW'), '2 小時後重置');
  const html=renderAuxPaneHtml({version:'2.13.1',language:'zh-TW'});
  assert.match(html,/<html lang="zh-TW">/);
  assert.ok(html.includes('需要重啟 Antigravity 以啟用 Powertools 外掛'));
  assert.ok(html.includes('檢查外掛更新'));
  // Ensure settings store accepts zh-TW
  const dir=mkdtempSync(join(tmpdir(),'agy-lang-tw-'));
  try{
    const store=createSettingsStore(dir);
    assert.equal(store.set({language:'zh-TW'}).language,'zh-TW');
    assert.equal(store.get().language,'zh-TW');
  }finally{rmSync(dir,{recursive:true,force:true});}
  // Ensure no common simplified-only glyphs remain across UI source files after toZhTw
  const simplifiedOnly=/[万与个为义于产仅从仓们价优会传体余侧关内写准减凑凭击划则刚创删务动区协单占却历压参发变号后听启周响唤围图圆场声处备头夹实审对导将尝尽层带帮并广库应开异强归当录径忆态总战执扩扬抢护报担拦择挂换据数断无旧时昵显暂机权条来栏树样档检汇没洁浅测浏滚满点热状独环现电监盘码确碍离积称稳筛签简类紧级线组细织终结给络绝统继续缓编缩网联脑范营补装观规视览触计订认让议记许设访证识诊试话询该详语误说请读调败账费资转轮软载较辅辑输边过运这进远违连迟适选遥邮采钟钥钮链销错键长闭问闲间阅队阶际险随隐静页顶项顺顿预频题额风馈驻验骤麦标]/;
  for(const file of ['lib/native-i18n.js','lib/native-panels.js','lib/native-ui.js','lib/sidecar-ui.mjs']){
    const converted=toZhTw(readFileSync(file,'utf8')).replace(/简体中文|批准/g,'');
    const leftover=converted.match(simplifiedOnly);
    assert.equal(leftover,null,`Unexpected simplified glyph ${leftover?.[0]} in ${file}`);
  }
});
