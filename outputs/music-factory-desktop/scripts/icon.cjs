'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const sharp=require('sharp');
(async()=>{
 const root=path.resolve(__dirname,'../assets'),set=path.join(root,'MusicFactory.iconset');fs.mkdirSync(set,{recursive:true});
 for(const size of [16,32,128,256,512])for(const scale of [1,2])await sharp(path.join(root,'icon.svg')).resize(size*scale,size*scale).png().toFile(path.join(set,`icon_${size}x${size}${scale===2?'@2x':''}.png`));
 const chunks=[];for(const [type,size] of [['ic07',128],['ic08',256],['ic09',512],['ic10',1024]]){const png=await sharp(path.join(root,'icon.svg')).resize(size,size).png().toBuffer(),head=Buffer.alloc(8);head.write(type);head.writeUInt32BE(png.length+8,4);chunks.push(head,png);}const data=Buffer.concat(chunks),head=Buffer.alloc(8);head.write('icns');head.writeUInt32BE(data.length+8,4);fs.writeFileSync(path.join(root,'icon.icns'),Buffer.concat([head,data]));
 const png=await sharp(path.join(root,'icon.svg')).resize(256,256).png().toBuffer(),h=Buffer.alloc(22);h.writeUInt16LE(1,2);h.writeUInt16LE(1,4);h.writeUInt16LE(1,10);h.writeUInt16LE(32,12);h.writeUInt32LE(png.length,14);h.writeUInt32LE(22,18);fs.writeFileSync(path.join(root,'icon.ico'),Buffer.concat([h,png]));
})().catch(e=>{console.error(e);process.exitCode=1;});
