'use strict';
// Produces native launchers and bundled Node/Chromium; end users need no Node.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
(async()=>{
  const {packager}=await import('@electron/packager');
  const platform=process.argv[2]||process.platform,arch=process.argv[3]||process.arch;
  if(!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch))throw new Error('Use darwin arm64, darwin x64, or win32 x64');
  const root=path.resolve(__dirname,'..'),outputs=path.resolve(root,'..');
  const seed=path.join(outputs,'public_upload_batches','us_2026_09_08');
  const out=process.env.FACTORY_RELEASE_OUT||path.join(outputs,'releases',`v${require('../package.json').version}`);
  const cache=path.resolve(outputs,'..','work','electron-cache');
  const built=await packager({dir:root,name:'Music Factory',platform,arch,electronVersion:require('../package.json').devDependencies.electron,
    out,overwrite:true,asar:false,prune:false,download:{cacheRoot:cache},appBundleId:'local.musicfactory.desktop',
    appCopyright:'Music Factory — local personal workspace',executableName:'Music Factory',icon:path.join(root,'assets',platform==='darwin'?'icon.icns':'icon.ico'),
    ignore:[/^\/node_modules($|\/)/,/^\/test($|\/)/,/^\/scripts($|\/)/,/\.test\.cjs$/,/__pycache__/ ,/^\/assets\/MusicFactory.iconset($|\/)/,/^\/extension\/test($|\/)/,/^\/pnpm-lock.yaml$/,/^\/pnpm-workspace.yaml$/],
    extendInfo:platform==='darwin'?{CFBundleDisplayName:'Music Factory',NSHighResolutionCapable:true}:undefined});
  for(const folder of built){
    const resources=platform==='darwin'?path.join(folder,'Music Factory.app','Contents','Resources'):path.join(folder,'resources');
    // The application uses the system Chrome channel, so only the small Playwright
    // controller is bundled; no extra browser download is required.
    const appModules=path.join(resources,'app','node_modules');fs.mkdirSync(appModules,{recursive:true});
    fs.cpSync(path.join(root,'node_modules','playwright-core'),path.join(appModules,'playwright-core'),{recursive:true,dereference:true});
    if(fs.existsSync(path.join(seed,'publish_manifest.json'))){
      const destination=path.join(resources,'seed-batches');fs.mkdirSync(destination,{recursive:true});
      const manifest=JSON.parse(fs.readFileSync(path.join(seed,'publish_manifest.json'),'utf8'));
      for(const group of manifest.accounts){
        const id={'bos-423483424':'bos','gleb-oxaj':'gleb','nn1v-680019554':'gleb','rivi-135338423':'rivi'}[group.account];
        for(const track of group.tracks){const target=path.join(destination,id,track.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(seed,id,track.file),target);}
        group.folder=id;
        if(id==='gleb')group.account='nn1v-680019554';
      }
      fs.writeFileSync(path.join(destination,'publish_manifest.json'),JSON.stringify(manifest,null,2));
    }
    const readme=path.join(root,'README-RU.md');if(fs.existsSync(readme))fs.copyFileSync(readme,path.join(folder,'START HERE.md'));
    const handoff=path.join(root,'WINDOWS-CODEX-HANDOFF.md');if(fs.existsSync(handoff))fs.copyFileSync(handoff,path.join(folder,'CODEX WINDOWS.md'));
    const prompt=path.join(root,'WINDOWS-CODEX-PROMPT.txt');if(fs.existsSync(prompt))fs.copyFileSync(prompt,path.join(folder,'PROMPT FOR CODEX WINDOWS.txt'));
    if(platform==='darwin'&&process.platform==='darwin'){
      const appPath=path.join(folder,'Music Factory.app');
      const result=spawnSync('/usr/bin/codesign',['--force','--deep','--sign','-',appPath],{encoding:'utf8'});
      if(result.status!==0)throw new Error('Ad-hoc signing failed: '+result.stderr);
    }
    console.log('Packaged: '+folder);
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
