'use strict';
const path=require('node:path');const {pathToFileURL}=require('node:url');
(async()=>{const resolved=require.resolve('@electron/get',{paths:[require.resolve('@electron/packager')]});
const {downloadArtifact}=await import(pathToFileURL(resolved).href);
console.log(await downloadArtifact({version:require('../package.json').devDependencies.electron,artifactName:'electron',platform:process.argv[2]||'win32',arch:process.argv[3]||'x64',cacheRoot:path.resolve(__dirname,'../../../work/electron-cache')}));
})().catch(e=>{console.error(e);process.exitCode=1;});
