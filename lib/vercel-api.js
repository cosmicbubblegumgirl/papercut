'use strict';

const crypto=require('node:crypto');
const path=require('node:path');
const {neon}=require('@neondatabase/serverless');
const {hashPassword,verifyPassword,newSessionToken,hashToken,normaliseEmail}=require('../src/auth');
const {buildRoadmap}=require('../src/clarity');

const DAY=86400000;
const MAX_FILE_BYTES=3*1024*1024;
let sql;
let setupPromise;

function database(){
  if(!process.env.DATABASE_URL) {
    const error=new Error('PaperCut storage has not been connected. Add DATABASE_URL to this Vercel project and redeploy.');
    error.status=503;
    throw error;
  }
  if(!sql)sql=neon(process.env.DATABASE_URL);
  return sql;
}
async function setup(){
  if(!setupPromise){
    setupPromise=(async()=>{
      const db=database();
      await db.query("CREATE TABLE IF NOT EXISTS pc_users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      await db.query("CREATE TABLE IF NOT EXISTS pc_sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES pc_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      await db.query("CREATE INDEX IF NOT EXISTS pc_sessions_expiry_idx ON pc_sessions (expires_at)");
      await db.query("CREATE TABLE IF NOT EXISTS pc_documents (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES pc_users(id) ON DELETE CASCADE, title TEXT NOT NULL, source_text TEXT NOT NULL, roadmap_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      await db.query("CREATE INDEX IF NOT EXISTS pc_documents_user_idx ON pc_documents (user_id,created_at DESC)");
      await db.query("CREATE TABLE IF NOT EXISTS pc_progress (document_id BIGINT NOT NULL REFERENCES pc_documents(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES pc_users(id) ON DELETE CASCADE, step_id TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY(document_id,user_id,step_id))");
      await db.query("CREATE TABLE IF NOT EXISTS pc_preferences (user_id BIGINT PRIMARY KEY REFERENCES pc_users(id) ON DELETE CASCADE, large_text BOOLEAN NOT NULL DEFAULT false, high_contrast BOOLEAN NOT NULL DEFAULT false, reduced_motion BOOLEAN NOT NULL DEFAULT false)");
    })().catch(error=>{setupPromise=null;throw error;});
  }
  return setupPromise;
}
function send(res,status,body){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(status).json(body);
}
function body(req){
  if(!req.body) return {};
  if(typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
  try{return JSON.parse(String(req.body));}catch{
    const e=new Error('Invalid JSON request.');e.status=400;throw e;
  }
}
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function method(req,expected){if(req.method!==expected)fail('Method not allowed.',405);}
function getToken(req){
  const auth=String(req.headers.authorization||'');
  const match=/^Bearer\s+(.+)$/i.exec(auth);
  return match?match[1]:'';
}
async function currentUser(req){
  const token=getToken(req);
  if(!token||token.length>512)fail('Please sign in to continue.',401);
  const rows=await database().query("SELECT u.id,u.name,u.email,u.created_at FROM pc_users u JOIN pc_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() LIMIT 1",[hashToken(token)]);
  if(!rows.length)fail('Your session has expired. Please sign in.',401);
  return rows[0];
}
function safeInt(value){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1)fail('Invalid document ID.');
  return number;
}
function roadmapFromText(text,title){
  const result=buildRoadmap(text,title);
  return {
    summary:result.summary,
    steps:result.steps.map(step=>({id:step.id,text:step.label,done:false})),
    deadlines:result.deadlines.map(deadline=>({label:deadline.raw,iso:deadline.iso})),
    requirements:result.requirements,
    contacts:[...result.contacts.emails,...result.contacts.phones],
    note:'Check all dates, requirements and instructions against the original document.'
  };
}
async function mapDocument(row){
  const raw=typeof row.roadmap_json==='string'?JSON.parse(row.roadmap_json):row.roadmap_json;
  const found=await database().query("SELECT step_id,done FROM pc_progress WHERE document_id=$1 AND user_id=$2",[row.id,row.user_id]);
  const checked=new Map(found.map(x=>[x.step_id,x.done]));
  return {id:Number(row.id),title:row.title,createdAt:row.created_at,roadmap:{
    ...raw,steps:(raw.steps||[]).map(x=>({...x,done:checked.get(x.id)===true}))
  }};
}
async function listDocuments(userId){
  const rows=await database().query("SELECT id,user_id,title,roadmap_json,created_at FROM pc_documents WHERE user_id=$1 ORDER BY created_at DESC,id DESC",[userId]);
  return Promise.all(rows.map(mapDocument));
}
async function ownDocument(userId,documentId){
  const rows=await database().query("SELECT id,user_id,title,roadmap_json,created_at FROM pc_documents WHERE id=$1 AND user_id=$2 LIMIT 1",[documentId,userId]);
  if(!rows.length)fail('Document not found.',404);
  return rows[0];
}
async function readDocument(data){
  let source=String(data.text||'');
  if(!data.fileBase64)return source;
  const name=String(data.filename||'').slice(0,180);
  const extension=path.extname(name).toLowerCase();
  const encoded=String(data.fileBase64);
  if(encoded.length>Math.ceil(MAX_FILE_BYTES*4/3)+4)fail('This file is too large for the online upload. Choose a file under 3 MB or paste its text.',413);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))fail('Invalid uploaded file.');
  const buffer=Buffer.from(encoded,'base64');
  if(buffer.length>MAX_FILE_BYTES)fail('This file is too large for the online upload. Choose a file under 3 MB or paste its text.',413);
  if(['.txt','.md','.csv','.json','.html','.rtf'].includes(extension))return buffer.toString('utf8');
  if(extension==='.pdf'){
    try{const pdfParse=require('pdf-parse');return (await pdfParse(buffer)).text;}catch{fail('Could not read that PDF. Try a selectable-text PDF or paste the text.');}
  }
  if(extension==='.docx'){
    try{const mammoth=require('mammoth');return (await mammoth.extractRawText({buffer})).value;}catch{fail('Could not read that Word document. Paste the text instead.');}
  }
  fail('This online version accepts PDF, DOCX and text files. For images or older Word formats, paste the text first.');
}
async function run(route,req,res){
  res.setHeader('Access-Control-Allow-Origin',String(process.env.ALLOWED_ORIGIN||'').trim()||'https://cosmicbubblegumgirl.github.io');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(route==='health'){
    method(req,'GET');
    if(!process.env.DATABASE_URL)return send(res,503,{service:'papercut',status:'setup_required',database:false});
    await setup();
    return send(res,200,{service:'papercut',status:'ok',database:true});
  }
  await setup();
  const db=database();
  if(route==='signup'){
    method(req,'POST');
    const data=body(req);
    const name=String(data.name||'').trim().slice(0,80),email=normaliseEmail(data.email),password=String(data.password||'');
    if(name.length<2)fail('Please enter your name.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail('Please enter a valid email.');
    if(password.length<8||password.length>256)fail('Use a password between 8 and 256 characters.');
    const rows=await db.query("INSERT INTO pc_users(name,email,password_hash) VALUES($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id,name,email",[name,email,hashPassword(password)]);
    if(!rows.length)fail('An account already exists for that email.',409);
    const user=rows[0],token=newSessionToken();
    await db.query("INSERT INTO pc_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",[hashToken(token),user.id,new Date(Date.now()+30*DAY).toISOString()]);
    return send(res,200,{user,token});
  }
  if(route==='signin'){
    method(req,'POST');
    const data=body(req),email=normaliseEmail(data.email),password=String(data.password||'');
    if(email.length>254||password.length>256)fail('Email or password is incorrect.',401);
    const rows=await db.query("SELECT id,name,email,password_hash FROM pc_users WHERE email=$1 LIMIT 1",[email]);
    if(!rows.length||!verifyPassword(password,rows[0].password_hash))fail('Email or password is incorrect.',401);
    const {id,name}=rows[0],token=newSessionToken();
    await db.query("INSERT INTO pc_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",[hashToken(token),id,new Date(Date.now()+30*DAY).toISOString()]);
    return send(res,200,{user:{id,name,email},token});
  }
  if(route==='signout'){
    method(req,'POST');
    const token=getToken(req);
    if(token)await db.query("DELETE FROM pc_sessions WHERE token_hash=$1",[hashToken(token)]);
    return send(res,200,{ok:true});
  }
  const user=await currentUser(req);
  if(route==='me'){
    method(req,'GET');
    return send(res,200,{user});
  }
  if(route==='dashboard'||route==='documents'){
    if(req.method==='GET'){
      const documents=await listDocuments(user.id);
      if(route==='documents')return send(res,200,{documents});
      let tasksTotal=0,tasksDone=0,nextDeadline=null;
      for(const document of documents){
        tasksTotal+=document.roadmap.steps.length;
        tasksDone+=document.roadmap.steps.filter(x=>x.done).length;
        for(const date of document.roadmap.deadlines||[]){
          if(date.iso&&(!nextDeadline||date.iso<nextDeadline.iso))nextDeadline={...date,title:document.title,documentId:document.id};
        }
      }
      return send(res,200,{documents,stats:{documentCount:documents.length,tasksTotal,tasksDone,nextDeadline}});
    }
    if(route==='documents'&&req.method==='POST'){
      const data=body(req),title=String(data.title||data.filename||'My document').trim().slice(0,140)||'My document';
      const source=String(await readDocument(data)).replace(/\r/g,'').slice(0,500000).trim();
      if(source.length<20)fail('Please provide at least 20 readable characters.');
      const roadmap=roadmapFromText(source,title);
      const rows=await db.query("INSERT INTO pc_documents(user_id,title,source_text,roadmap_json) VALUES($1,$2,$3,$4::jsonb) RETURNING id,user_id,title,roadmap_json,created_at",[user.id,title,source,JSON.stringify(roadmap)]);
      return send(res,200,{document:await mapDocument(rows[0])});
    }
    fail('Method not allowed.',405);
  }
  if(route==='document'){
    const id=safeInt(req.query.id),document=await ownDocument(user.id,id);
    if(req.method==='GET')return send(res,200,{document:await mapDocument(document)});
    if(req.method==='DELETE'){
      await db.query("DELETE FROM pc_documents WHERE id=$1 AND user_id=$2",[id,user.id]);
      return send(res,200,{ok:true});
    }
    fail('Method not allowed.',405);
  }
  if(route==='progress'){
    method(req,'PATCH');
    const id=safeInt(req.query.id),stepId=String(req.query.stepId||'').slice(0,120),document=await ownDocument(user.id,id);
    const roadmap=typeof document.roadmap_json==='string'?JSON.parse(document.roadmap_json):document.roadmap_json;
    if(!roadmap.steps.some(x=>x.id===stepId))fail('Step not found.',404);
    const done=body(req).done===true;
    await db.query("INSERT INTO pc_progress(document_id,user_id,step_id,done) VALUES($1,$2,$3,$4) ON CONFLICT(document_id,user_id,step_id) DO UPDATE SET done=excluded.done",[id,user.id,stepId,done]);
    return send(res,200,{ok:true,done});
  }
  if(route==='preferences'){
    if(req.method==='GET'){
      const rows=await db.query("SELECT large_text,high_contrast,reduced_motion FROM pc_preferences WHERE user_id=$1 LIMIT 1",[user.id]);
      const pref=rows[0]||{};
      return send(res,200,{preferences:{largeText:!!pref.large_text,highContrast:!!pref.high_contrast,reducedMotion:!!pref.reduced_motion}});
    }
    if(req.method==='PATCH'){
      const data=body(req);
      await db.query("INSERT INTO pc_preferences(user_id,large_text,high_contrast,reduced_motion) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET large_text=excluded.large_text,high_contrast=excluded.high_contrast,reduced_motion=excluded.reduced_motion",[user.id,!!data.largeText,!!data.highContrast,!!data.reducedMotion]);
      return send(res,200,{ok:true});
    }
    fail('Method not allowed.',405);
  }
  fail('API endpoint not found.',404);
}
function handler(route){
  return async function(req,res){
    try{return await run(route,req,res);}
    catch(error){
      const status=Number(error.status)||500;
      if(status>=500)console.error('PaperCut API error:',error);
      return send(res,status,{error:status===500?'PaperCut could not complete that request. Please try again.':error.message});
    }
  };
}
module.exports={handler};
