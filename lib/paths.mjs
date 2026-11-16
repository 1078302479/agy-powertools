import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';

export function antigravityUserDataDir({ platform=process.platform, env=process.env, home=homedir() }={}) {
  if(env.ANTIGRAVITY_USER_DATA_DIR)return env.ANTIGRAVITY_USER_DATA_DIR;
  const path=platform==='win32'?win32:posix;
  if(platform==='win32')return path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'Antigravity');
  if(platform==='darwin')return path.join(home,'Library','Application Support','Antigravity');
  return path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'Antigravity');
}

export function devToolsPortFile(options={}) {
  return options.portFile||(options.env||process.env).ANTIGRAVITY_CDP_PORT_FILE||
    (options.platform==='win32'||!options.platform&&process.platform==='win32'?win32:posix).join(antigravityUserDataDir(options),'DevToolsActivePort');
}

export const pluginDataDir=()=>join(homedir(),'.gemini','antigravity','plugin_data','agy-powertools');
