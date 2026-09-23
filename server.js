'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8787);
const DB_FILE = path.resolve(process.env.PAPERCUT_DB || './data/papercut.db');
const STATIC_DIR = path.resolve(__dirname, 'docs');
const DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 30));
const MAX_BYTES = Math.min(20, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 12))) * 1024 * 1024;
const ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || 'http://localhost:8787,http://localhost:3000,https://cosmicbubblegumgirl.github.io')
  .split(',').map(value => value.trim()).filter(Boolean));
fs.mkdirSync(path.dirname(DB_FILE), { recursive:true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec([
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE COLLATE NOCASE NOT NULL, pass TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, source_text TEXT NOT NULL, roadmap_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS progress (document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, step_id TEXT NOT NULL, done INTEGER DEFAULT 0, PRIMARY KEY(document_id,user_id,step_id))',
  'CREATE TABLE IF NOT EXISTS preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, large_text INTEGER DEFAULT 0, high_contrast INTEGER DEFAULT 0, reduced_motion INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id,created_at DESC)'
].join(';') + ';');

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function passwordHash(value) {
  const salt=crypto.randomBytes(16).toString('hex');
  return salt+':'+crypto.scryptSync(value,salt,64).toString('hex');
}
function passwordMatches(input,stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt,original]=stored.split(':');
  if (!/^[a-f0-9]{128}$/.test(original)) return false;
  const digest=crypto.scryptSync(input,salt,64);
  return crypto.timingSafeEqual(digest,Buffer.from(original,'hex'));
}
function issueSession(userId) {
  const token=crypto.randomBytes(32).toString('hex');
  const expiry=new Date(Date.now()+DAYS*86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token),userId,expiry);
  return {token,expiry};
}
function currentUser(req) {
  const header=String(req.headers.authorization || '');
  const bearer=/^Bearer\s+(.+)$/i.exec(header);
  const cookie=String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('papercut_session='));
  const token=bearer?bearer[1]:(cookie?decodeURIComponent(cookie.slice(17)):'');
  if(!token || token.length>512)return null;
  return db.prepare('SELECT u.id,u.name,u.email,u.created_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?')
    .get(sha(token),new Date().toISOString()) || null;
}
function cors(req) {
  const origin=req.headers.origin;
  if (!origin || !ORIGINS.has(origin))return {};
  return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Credentials':'true','Vary':'Origin'};
}
function response(req,res,status,data,headers={}) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',...cors(req),...headers});
  res.end(JSON.stringify(data));
}
function failure(req,res,code,message) { response(req,res,code,{error:message}); }
function requireUser(req,res) {
  const user=currentUser(req);
  if(!user)failure(req,res,401,'Please sign in to continue.');
  return user;
}
async function bodyJSON(req) {
  const chunks=[];let length=0;
  for await(const chunk of req) {
    length+=chunk.length;
    if(length>Math.ceil(MAX_BYTES*1.5)+1048576)throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  const data=Buffer.concat(chunks).toString('utf8');
  try { return data?JSON.parse(data):{}; } catch { throw new Error('Invalid JSON request.'); }
}
function ownDocument(userId,id) {
  return db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(id,userId);
}
function mappedDocument(row,userId) {
  const roadmap=JSON.parse(row.roadmap_json);
  const tracked=db.prepare('SELECT step_id,done FROM progress WHERE user_id=? AND document_id=?').all(userId,row.id);
  const done=new Map(tracked.map(x=>[x.step_id,!!x.done]));
  roadmap.steps=roadmap.steps.map(step=>({...step,done:done.get(step.id)||false}));
  return {id:row.id,title:row.title,createdAt:row.created_at,roadmap};
}
function allDocuments(userId) {
  return db.prepare('SELECT * FROM documents WHERE user_id=? ORDER BY datetime(created_at) DESC,id DESC')
    .all(userId).map(row=>mappedDocument(row,userId));
}
function documentSummary(userId) {
  const docs=allDocuments(userId);let tasksTotal=0,tasksDone=0,nextDeadline=null;
  for(const doc of docs) {
    for(const step of doc.roadmap.steps){tasksTotal++;if(step.done)tasksDone++;}
    for(const deadline of doc.roadmap.deadlines||[]){
      if(deadline.iso&&(!nextDeadline||deadline.iso<nextDeadline.iso))
        nextDeadline={...deadline,title:doc.title,documentId:doc.id};
    }
  }
  return {documents:docs,stats:{documentCount:docs.length,tasksTotal,tasksDone,nextDeadline}};
}
function xmlText(xml) {
  return xml.replace(/<w:tab\b[^>]*\/>/gi,' ').replace(/<\/w:p>/gi,'\n')
    .replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function extractFile(buffer,filename,mimeType) {
  if(buffer.length>MAX_BYTES)throw new Error('The file exceeds the upload limit.');
  const extension=path.extname(filename||'').toLowerCase();
  if(['.txt','.md','.csv','.html','.json','.xml','.rtf'].includes(extension)||/^text\//.test(mimeType))
    return buffer.toString('utf8');
  if(!['.pdf','.doc','.docx','.odt','.png','.jpg','.jpeg','.webp'].includes(extension))
    throw new Error('Unsupported file type. Try PDF, Word, image or plain text.');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'papercut-'));
  const local=path.join(folder,'document'+extension);
  fs.writeFileSync(local,buffer,{mode:0o600});
  try {
    let command,args;
    if(extension==='.pdf'){command='pdftotext';args=['-layout',local,'-'];}
    else if(extension==='.docx'){
      command='unzip';args=['-p',local,'word/document.xml'];
    } else if(extension==='.doc'||extension==='.odt') {
      command='pandoc';args=[local,'-t','plain'];
    } else {command='tesseract';args=[local,'stdout'];}
    const result=spawnSync(command,args,{encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});
    if(result.error&&result.error.code==='ENOENT')
      throw new Error('This file needs an extraction utility that is not installed on the server. Paste the document text instead.');
    if(result.status!==0)throw new Error('Could not read this file. Paste its text or try a clearer copy.');
    return extension==='.docx'?xmlText(result.stdout):result.stdout;
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
}
function roadmapFromText(source,title) {
  const text=String(source).replace(/\r/g,'').trim();
  const sentences=text.split(/[\n]+|(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.length>9);
  const useful=sentences.filter(s=>/\b(submit|upload|provide|attach|send|complete|register|sign|bring|pay|return|reply|email|confirm|contact|attend|collect|download|visit|report|present)\b/i.test(s)).slice(0,12);
  const actions=useful.length?useful:[
    'Read the notice carefully and identify what is being requested.',
    'Gather the information and documents mentioned in the notice.',
    'Confirm the deadline and method of submission before taking action.'
  ];
  const dateMatches=Array.from(text.matchAll(/\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/gi));
  const requirements=Array.from(new Set((text.match(/\b(?:certified (?:copy of )?ID|proof of address|identity document|bank statement|application form|reference number|birth certificate|passport|proof of payment)\b/gi)||[]).map(s=>s.trim()))).slice(0,12);
  const contacts=Array.from(new Set((text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)||[]))).slice(0,8);
  const deadlines=Array.from(new Set(dateMatches.map(m=>m[0]))).slice(0,8).map((date,i)=>{
    let iso=null;
    if(/^\d{4}-\d{2}-\d{2}$/.test(date))iso=date;
    else if(/\d{1,2}\s+[A-Za-z]+\s+\d{4}/.test(date)){
      const parsed=new Date(date+' UTC');
      if(!Number.isNaN(parsed.getTime()))iso=parsed.toISOString().slice(0,10);
    }
    return {id:'deadline'+(i+1),label:date,iso};
  });
  return {summary:sentences.slice(0,2).join(' ').slice(0,520)||title,
    steps:actions.map((s,i)=>({id:'step'+(i+1),text:s,done:false})),
    deadlines,requirements,contacts,
    note:'Automatically detected details can be incomplete. Confirm all dates and actions against the original document.'};
}
function jsonError(req,res,error) {
  const message=error && error.message?error.message:'Unable to complete request.';
  const code=/too large|exceeds the upload limit/i.test(message)?413:400;
  failure(req,res,code,message);
}
async function route(req,res,url) {
  const endpoint=url.pathname;const method=req.method;
  if(method==='OPTIONS'){res.writeHead(204,cors(req));res.end();return;}
  if(endpoint==='/api/health'&&method==='GET')return response(req,res,200,{service:'papercut',status:'ok'});
  if(endpoint==='/api/auth/signup'&&method==='POST'){
    const data=await bodyJSON(req);
    const name=String(data.name||'').trim().slice(0,80);
    const email=String(data.email||'').trim().toLowerCase();
    const password=String(data.password||'');
    if(name.length<2)return failure(req,res,400,'Please enter your name.');
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return failure(req,res,400,'Please enter a valid email.');
    if(password.length<8||password.length>256)return failure(req,res,400,'Use a password between 8 and 256 characters.');
    try {
      const result=db.prepare('INSERT INTO users(name,email,pass) VALUES(?,?,?)').run(name,email,passwordHash(password));
      db.prepare('INSERT OR IGNORE INTO preferences(user_id) VALUES(?)').run(result.lastInsertRowid);
      const session=issueSession(result.lastInsertRowid);
      return response(req,res,200,{user:{id:Number(result.lastInsertRowid),name,email},token:session.token},
        {'Set-Cookie':'papercut_session='+encodeURIComponent(session.token)+'; Path=/; HttpOnly; SameSite=Lax; Expires='+new Date(session.expiry).toUTCString()});
    } catch(e) {
      if(/UNIQUE/i.test(e.message))return failure(req,res,409,'An account already exists for that email.');
      throw e;
    }
  }
  if(endpoint==='/api/auth/signin'&&method==='POST'){
    const data=await bodyJSON(req);const email=String(data.email||'').trim().toLowerCase();
    const row=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!row||!passwordMatches(String(data.password||''),row.pass))return failure(req,res,401,'Email or password is incorrect.');
    const session=issueSession(row.id);
    return response(req,res,200,{user:{id:row.id,name:row.name,email:row.email},token:session.token});
  }
  if(endpoint==='/api/auth/signout'&&method==='POST'){
    const token=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization||''));
    if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token[1]));
    return response(req,res,200,{ok:true},{'Set-Cookie':'papercut_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});
  }
  if(endpoint==='/api/auth/me'&&method==='GET'){
    const user=requireUser(req,res);if(user)return response(req,res,200,{user});return;
  }
  const user=requireUser(req,res);if(!user)return;
  if(endpoint==='/api/dashboard'&&method==='GET')return response(req,res,200,documentSummary(user.id));
  if(endpoint==='/api/documents'&&method==='GET')return response(req,res,200,{documents:allDocuments(user.id)});
  if(endpoint==='/api/documents'&&method==='POST'){
    const data=await bodyJSON(req);
    const title=String(data.title||data.filename||'My document').trim().slice(0,140);
    let text=String(data.text||'');
    if(data.fileBase64){
      if(String(data.fileBase64).length>Math.ceil(MAX_BYTES*1.45))return failure(req,res,413,'File exceeds upload limit.');
      text=extractFile(Buffer.from(String(data.fileBase64),'base64'),String(data.filename||''),String(data.mimeType||''));
    }
    text=text.slice(0,500000).trim();
    if(text.length<20)return failure(req,res,400,'Please provide at least 20 readable characters.');
    const roadmap=roadmapFromText(text,title);
    const result=db.prepare('INSERT INTO documents(user_id,title,source_text,roadmap_json) VALUES(?,?,?,?)')
      .run(user.id,title,text,JSON.stringify(roadmap));
    return response(req,res,200,{document:mappedDocument(ownDocument(user.id,Number(result.lastInsertRowid)),user.id)});
  }
  const match=endpoint.match(/^\/api\/documents\/(\d+)$/);
  if(match){
    const id=Number(match[1]);const document=ownDocument(user.id,id);
    if(!document)return failure(req,res,404,'Document not found.');
    if(method==='GET')return response(req,res,200,{document:mappedDocument(document,user.id)});
    if(method==='DELETE'){db.prepare('DELETE FROM documents WHERE id=? AND user_id=?').run(id,user.id);return response(req,res,200,{ok:true});}
  }
  const progress=endpoint.match(/^\/api\/documents\/(\d+)\/steps\/([^/]+)$/);
  if(progress&&method==='PATCH'){
    const id=Number(progress[1]);const stepId=decodeURIComponent(progress[2]);
    const document=ownDocument(user.id,id);
    if(!document)return failure(req,res,404,'Document not found.');
    const roadmap=JSON.parse(document.roadmap_json);
    if(!roadmap.steps.some(step=>step.id===stepId))return failure(req,res,404,'Step not found.');
    const data=await bodyJSON(req);
    const done=data.done?1:0;
    db.prepare('INSERT INTO progress(document_id,user_id,step_id,done) VALUES(?,?,?,?) ON CONFLICT(document_id,user_id,step_id) DO UPDATE SET done=excluded.done')
      .run(id,user.id,stepId,done);
    return response(req,res,200,{ok:true,done:!!done});
  }
  if(endpoint==='/api/preferences'&&method==='GET'){
    const settings=db.prepare('SELECT * FROM preferences WHERE user_id=?').get(user.id)||{};
    return response(req,res,200,{preferences:{largeText:!!settings.large_text,highContrast:!!settings.high_contrast,reducedMotion:!!settings.reduced_motion}});
  }
  if(endpoint==='/api/preferences'&&method==='PATCH'){
    const data=await bodyJSON(req);
    db.prepare('INSERT INTO preferences(user_id,large_text,high_contrast,reduced_motion) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET large_text=excluded.large_text,high_contrast=excluded.high_contrast,reduced_motion=excluded.reduced_motion')
      .run(user.id,data.largeText?1:0,data.highContrast?1:0,data.reducedMotion?1:0);
    return response(req,res,200,{ok:true});
  }
  return failure(req,res,404,'API endpoint not found.');
}
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json; charset=utf-8'};
function serve(req,res,url){
  const decoded=decodeURIComponent(url.pathname);
  const requested=decoded==='/'?'index.html':decoded.replace(/^\/+/, '');
  const file=path.resolve(STATIC_DIR,requested);
  if(file!==STATIC_DIR&&!file.startsWith(STATIC_DIR+path.sep)){
    return failure(req,res,403,'Forbidden.');
  }
  fs.readFile(file,(error,bytes)=>{
    if(error)return failure(req,res,404,'Page not found.');
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'public,max-age=300'});
    res.end(bytes);
  });
}
const server=http.createServer((req,res)=>{
  let url;
  try{url=new URL(req.url,'http://localhost');}catch{return failure(req,res,400,'Invalid URL.');}
  if(url.pathname.startsWith('/api/'))route(req,res,url).catch(error=>jsonError(req,res,error));
  else serve(req,res,url);
});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log('PaperCut listening on port '+PORT));
module.exports={server,db,roadmapFromText};
