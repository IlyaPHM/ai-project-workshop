// First deployment without the paid provider key. The API stays closed until it is added.
import {readFile,mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const config=JSON.parse((await readFile('wrangler.jsonc','utf8')).replace(/^\s*\/\/.*$/gm,''));
delete config.secrets;
config.main=resolve('src/worker.ts');
config.$schema=resolve('node_modules/wrangler/config-schema.json');
await mkdir('.wrangler',{recursive:true});
const temporary=resolve('.wrangler/bootstrap-config.json');
await writeFile(temporary,JSON.stringify(config,null,2));
try{
  const args=[resolve('node_modules/wrangler/bin/wrangler.js'),'deploy','--config',temporary,'--secrets-file',resolve('.secrets/cloudflare-secrets.json')];
  if(process.argv.includes('--dry-run'))args.push('--dry-run');
  const result=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}finally{await unlink(temporary);}
