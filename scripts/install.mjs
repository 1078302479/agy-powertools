import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin } from '../lib/lifecycle.mjs';
const [major,minor]=process.versions.node.split('.').map(Number);
try{
  if(major<22||major===22&&minor<13)throw Error('需要 Node.js 22.13 或更高版本');
  const args=process.argv.slice(2),homeIndex=args.indexOf('--home');
  const result=await installPlugin({source:resolve(dirname(fileURLToPath(import.meta.url)),'..'),home:homeIndex>=0?args[homeIndex+1]:undefined});
  if(args.includes('--json'))console.log(JSON.stringify(result));
  else{console.log(`已安装 Agy Powertools ${result.version}`);console.log('请重新打开 Antigravity，安装过程中没有关闭客户端。');}
}catch(error){console.error('安装失败：'+error.message);process.exitCode=1;}
