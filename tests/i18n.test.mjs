import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';
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
 assert.equal(t('Turbo','zh-CN'),'Turbo');assert.equal(t('当前会话','en'),'Current conversation');
});
