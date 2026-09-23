'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');

function run(cmd,args) {
  const result=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:15*1024*1024});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error((result.stderr||cmd+' failed').trim());
  return result.stdout||'';
}
function extractFromBuffer(buffer,filename,mimeType='') {
  const ext=path.extname(filename||'').toLowerCase();
  if(['.txt','.md','.csv','.json','.html','.htm'].includes(ext) || /^text\//i.test(mimeType)) {
    return buffer.toString('utf8');
  }
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'papercut-'));
  const source=path.join(temp,'upload'+(ext||'.bin'));
  fs.writeFileSync(source,buffer);
  try {
    if(ext==='.pdf'||mimeType==='application/pdf') {
      const output=path.join(temp,'document.txt');
      run('pdftotext',['-layout',source,output]);
      return fs.readFileSync(output,'utf8');
    }
    if(['.docx','.doc','.odt','.rtf'].includes(ext)) {
      return run('pandoc',[source,'-t','plain']);
    }
    if(/^image\//i.test(mimeType)||['.png','.jpg','.jpeg','.webp','.tif','.tiff','.bmp'].includes(ext)) {
      const output=path.join(temp,'ocr');
      run('tesseract',[source,output,'--dpi','300']);
      return fs.readFileSync(output+'.txt','utf8');
    }
    throw new Error('Unsupported file type. Try PDF, DOCX, TXT, or an image.');
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
module.exports={extractFromBuffer};
